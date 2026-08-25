import {
  ANGLE_DISTINCTNESS,
  ANGLE_VERDICT_LABELS_DE,
  classifyAngleSimilarity,
  DomainError,
  type AngleSpec,
  type AngleVerdict,
  type AttributionLevel,
  type SimilarCampaignReference,
} from '@am/domain';
import type { EmbeddingProvider } from './provider/types';

/**
 * Vector search over stored campaign embeddings.
 *
 * The similarity itself is arithmetic, not judgement: the model never sees a
 * score and never decides a verdict. `classifyAngleSimilarity` from `@am/domain`
 * owns the thresholds, so the console, the pipeline and this module cannot
 * disagree about what "too similar" means.
 */

/* -------------------------------------------------------------------------- */
/* Cosine similarity                                                           */
/* -------------------------------------------------------------------------- */

export function dotProduct(a: readonly number[], b: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

export function magnitude(vector: readonly number[]): number {
  return Math.sqrt(dotProduct(vector, vector));
}

/**
 * Cosine similarity, clamped to [0, 1].
 *
 * Clamping is safe here because every producer in this package emits
 * non-negative vectors; the clamp exists to absorb floating-point drift at
 * exactly 1.0, which would otherwise fail `z.number().max(1)` on a
 * `SimilarCampaignReference`.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new DomainError('VALIDATION_FAILED', {
      messageDe: 'Vektoren unterschiedlicher Länge können nicht verglichen werden.',
      details: { left: a.length, right: b.length },
    });
  }
  const denominator = magnitude(a) * magnitude(b);
  if (denominator === 0) return 0;
  return Math.min(1, Math.max(0, dotProduct(a, b) / denominator));
}

/* -------------------------------------------------------------------------- */
/* Stored embeddings and search                                                */
/* -------------------------------------------------------------------------- */

export interface EmbeddingMetadata {
  campaignId: string;
  campaignName: string;
  angleName: string | null;
  offerName: string | null;
  /** ISO-8601 timestamp of when the campaign ran. */
  ranAt: string | null;
  outcomeSummary: string | null;
  attributionLevel: AttributionLevel | null;
  /** The text that was embedded — kept so a hit can be explained. */
  text: string;
}

export interface StoredEmbedding {
  id: string;
  vector: readonly number[];
  metadata: EmbeddingMetadata;
}

export interface SimilarityFilter {
  /** Inclusive lower bound on `ranAt` (ISO-8601). */
  from?: string;
  /** Inclusive upper bound on `ranAt` (ISO-8601). */
  to?: string;
  /** Only campaigns that ran within this many days of `now`. */
  recencyDays?: number;
  now?: string;
  /** Case-insensitive exact match on the stored angle name. */
  angleName?: string;
  /** Case-insensitive exact match on the stored offer name. */
  offerName?: string;
  /** Drop hits below this cosine. */
  minSimilarity?: number;
}

export interface SimilarityHit {
  record: StoredEmbedding;
  similarity: number;
}

function normalizeName(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

export function matchesFilter(record: StoredEmbedding, filter: SimilarityFilter = {}): boolean {
  const { ranAt } = record.metadata;

  if (filter.from || filter.to || filter.recencyDays !== undefined) {
    // A campaign without a run date cannot be placed in a window; excluding it
    // is the honest choice — silently treating it as recent would corrupt the
    // "recently used angle" check.
    if (!ranAt) return false;
    const at = Date.parse(ranAt);
    if (Number.isNaN(at)) return false;
    if (filter.from && at < Date.parse(filter.from)) return false;
    if (filter.to && at > Date.parse(filter.to)) return false;
    if (filter.recencyDays !== undefined) {
      const now = filter.now ? Date.parse(filter.now) : Date.now();
      if (at < now - filter.recencyDays * 86_400_000) return false;
    }
  }

  if (filter.angleName && normalizeName(record.metadata.angleName) !== normalizeName(filter.angleName)) {
    return false;
  }
  if (filter.offerName && normalizeName(record.metadata.offerName) !== normalizeName(filter.offerName)) {
    return false;
  }
  return true;
}

export interface TopKOptions {
  k?: number;
  filter?: SimilarityFilter;
}

/** Top-k nearest stored embeddings, filtered by metadata first. */
export function topKSimilar(
  query: readonly number[],
  records: readonly StoredEmbedding[],
  options: TopKOptions = {},
): SimilarityHit[] {
  const k = options.k ?? 5;
  const filter = options.filter ?? {};
  const minSimilarity = filter.minSimilarity ?? 0;

  return records
    .filter((record) => matchesFilter(record, filter))
    .map((record) => ({ record, similarity: cosineSimilarity(query, record.vector) }))
    .filter((hit) => hit.similarity >= minSimilarity)
    .sort(
      (a, b) =>
        b.similarity - a.similarity ||
        // Ties broken by id so the ordering is stable across runs.
        a.record.id.localeCompare(b.record.id),
    )
    .slice(0, k);
}

export function toSimilarCampaignReference(hit: SimilarityHit): SimilarCampaignReference {
  return {
    campaignId: hit.record.metadata.campaignId,
    campaignName: hit.record.metadata.campaignName,
    similarity: hit.similarity,
    ranAt: hit.record.metadata.ranAt,
    outcomeSummary: hit.record.metadata.outcomeSummary,
    attributionLevel: hit.record.metadata.attributionLevel,
  };
}

/* -------------------------------------------------------------------------- */
/* Angle distinctness                                                          */
/* -------------------------------------------------------------------------- */

/** Canonical text for embedding an angle. Order is fixed so hashes are stable. */
export function angleEmbeddingText(angle: AngleSpec): string {
  return [angle.name, angle.perspective, angle.keywords.join(', ')].join('\n');
}

export interface AngleDistinctnessOptions {
  embeddings: EmbeddingProvider;
  thresholds?: { iterationThreshold: number; blockThreshold: number };
  /** Overrides `ANGLE_DISTINCTNESS.recencyDays`. */
  recencyDays?: number;
  now?: string;
  topK?: number;
}

export interface AngleDistinctnessResult {
  verdict: AngleVerdict;
  verdictLabelDe: string;
  maxSimilarity: number;
  similarCampaigns: SimilarCampaignReference[];
  /** German explanation of what does and does not differentiate the angle. */
  explanationDe: string;
}

function describeCampaigns(references: readonly SimilarCampaignReference[]): string {
  const names = references.map((reference) => `„${reference.campaignName}“`);
  if (names.length === 0) return '';
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(', ')} und ${names[names.length - 1]}`;
}

function explain(
  verdict: AngleVerdict,
  candidate: AngleSpec,
  references: readonly SimilarCampaignReference[],
): string {
  if (references.length === 0) {
    return `Für den Angle „${candidate.name}“ liegen im gewählten Zeitraum keine vergleichbaren früheren Kampagnen vor. Die Perspektive „${candidate.perspective}“ ist im Index bislang nicht belegt.`;
  }
  const list = describeCampaigns(references);
  switch (verdict) {
    case 'TOO_SIMILAR':
      return `Der Angle „${candidate.name}“ liegt zu nah an ${list}. Die Perspektive „${candidate.perspective}“ wurde dort bereits bespielt – eine neue Formulierung genügt nicht, es braucht eine andere Sichtweise auf Problem oder Lösung.`;
    case 'ITERATION':
      return `Der Angle „${candidate.name}“ ist eine Iteration von ${list}. Er teilt die grundlegende Perspektive mit den bisherigen Kampagnen und variiert sie. Das ist zulässig, sollte aber als Weiterentwicklung geführt werden und nicht als neuer Angle – die Ergebnisse sind sonst nicht sauber vergleichbar.`;
    case 'DISTINCT':
    default:
      return `Der Angle „${candidate.name}“ ist eigenständig. Zwar existieren mit ${list} thematisch verwandte Kampagnen, die Perspektive „${candidate.perspective}“ unterscheidet sich jedoch deutlich von den dort verwendeten Sichtweisen.`;
  }
}

/**
 * Classifies a candidate angle against the historical index.
 *
 * Returns the verdict, the concrete campaigns behind it and a German
 * explanation that a reviewer can act on. The explanation is generated from the
 * computed result, not by a model, so it can never contradict the verdict.
 */
export async function checkAngleDistinctness(
  candidate: AngleSpec,
  history: readonly StoredEmbedding[],
  options: AngleDistinctnessOptions,
): Promise<AngleDistinctnessResult> {
  const thresholds = options.thresholds ?? ANGLE_DISTINCTNESS;
  const [vector] = await options.embeddings.embed([angleEmbeddingText(candidate)]);
  if (!vector) {
    throw new DomainError('PROVIDER_ERROR', {
      messageDe: 'Für den Angle konnte kein Embedding erzeugt werden.',
    });
  }

  const hits = topKSimilar(vector, history, {
    k: options.topK ?? 5,
    filter: {
      recencyDays: options.recencyDays ?? ANGLE_DISTINCTNESS.recencyDays,
      now: options.now,
    },
  });

  const similarCampaigns = hits.map(toSimilarCampaignReference);
  const maxSimilarity = hits.length > 0 ? hits[0]!.similarity : 0;
  const verdict = classifyAngleSimilarity(maxSimilarity, thresholds);

  return {
    verdict,
    verdictLabelDe: ANGLE_VERDICT_LABELS_DE[verdict],
    maxSimilarity,
    similarCampaigns,
    explanationDe: explain(verdict, candidate, similarCampaigns),
  };
}
