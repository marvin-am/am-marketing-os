import {
  CREATIVE_PRINCIPLES,
  DomainError,
  GENERATION_DEFAULTS,
  type CreativePrinciple,
  type MetaCopy,
} from '@am/domain';
import type { EmbeddingProvider } from './provider/types';
import { cosineSimilarity } from './similarity';
import { firstSentence, lexicalSimilarity } from './text';

/**
 * Creative diversity checking (spec §12).
 *
 * Six concepts are generated; at least five must be *conceptually* distinct
 * before the package may go to launch. "Conceptually" is made concrete here as
 * five measured axes plus the six mandated communication principles:
 *
 * - hook          — the first sentence and the headline, the only part most
 *                   people ever read;
 * - copy          — the whole ad text, token/shingle overlap blended with
 *                   embedding cosine (the AI-assisted half of the check);
 * - visual        — the described motif;
 * - proof         — which evidence the concept leans on;
 * - funnel promise— what the landing experience has to deliver.
 *
 * Two concepts sharing a communication principle are penalised rather than
 * rejected outright: the same principle can carry two genuinely different
 * ideas, but it makes collision far more likely, and the mandate is one
 * principle per concept.
 *
 * Concepts are then clustered: an edge between two concepts that exceed the
 * pair threshold, `distinctCount` is the number of connected components. That
 * is deliberately stricter than counting non-colliding pairs — three concepts
 * that each collide with the next are one idea told three ways, not three.
 */

export interface DiversityConcept {
  key: string;
  principle: CreativePrinciple;
  visualIdea: string;
  imagePrompt: string;
  proofUsed: string | null;
  funnelPromise: string;
  copy: MetaCopy;
}

export interface DiversityThresholds {
  /** Overall pair score at or above which two concepts count as the same idea. */
  pair: number;
  /** Added to the overall score when two concepts share a principle. */
  principlePenalty: number;
  /** Weight of embedding cosine inside the copy and visual axes. */
  embeddingWeight: number;
  /** Minimum number of conceptually distinct concepts required for launch. */
  minDistinctConcepts: number;
  weights: {
    hook: number;
    copy: number;
    visual: number;
    proof: number;
    promise: number;
  };
}

export const DIVERSITY_DEFAULTS: DiversityThresholds = {
  pair: 0.55,
  principlePenalty: 0.1,
  embeddingWeight: 0.4,
  minDistinctConcepts: GENERATION_DEFAULTS.minApprovedCreatives,
  weights: { hook: 0.25, copy: 0.3, visual: 0.2, proof: 0.1, promise: 0.15 },
};

export interface DiversityPair {
  aKey: string;
  bKey: string;
  hook: number;
  copy: number;
  visual: number;
  proof: number;
  promise: number;
  samePrinciple: boolean;
  /** Weighted score including the principle penalty, clamped to [0, 1]. */
  overall: number;
  tooSimilar: boolean;
  /** German explanation, present only when the pair is too similar. */
  reasonDe: string | null;
}

export interface DiversityReport {
  pairs: DiversityPair[];
  /** Number of conceptually distinct clusters. */
  distinctCount: number;
  blocked: boolean;
  reasonsDe: string[];
  /** Principles used at least once, in catalogue order. */
  principlesUsed: CreativePrinciple[];
  thresholds: DiversityThresholds;
}

export interface DiversityOptions {
  thresholds?: Partial<DiversityThresholds>;
  /** When omitted the check falls back to purely lexical similarity. */
  embeddings?: EmbeddingProvider;
}

const AXIS_LABELS_DE: Readonly<Record<'hook' | 'copy' | 'visual' | 'proof' | 'promise', string>> = {
  hook: 'Aufhänger',
  copy: 'Anzeigentext',
  visual: 'Bildidee',
  proof: 'verwendeter Beleg',
  promise: 'Funnel-Versprechen',
};

function mergeThresholds(overrides?: Partial<DiversityThresholds>): DiversityThresholds {
  return {
    ...DIVERSITY_DEFAULTS,
    ...overrides,
    weights: { ...DIVERSITY_DEFAULTS.weights, ...overrides?.weights },
  };
}

function hookText(concept: DiversityConcept): string {
  return `${firstSentence(concept.copy.primaryText)} ${concept.copy.headline}`;
}

function copyText(concept: DiversityConcept): string {
  return [
    concept.copy.primaryText,
    concept.copy.headline,
    concept.copy.description,
    concept.copy.callToAction,
  ].join(' ');
}

function visualText(concept: DiversityConcept): string {
  return `${concept.visualIdea} ${concept.imagePrompt}`;
}

/** Union-find over "too similar" edges. */
function countClusters(keys: readonly string[], edges: readonly [string, string][]): number {
  const parent = new Map<string, string>(keys.map((key) => [key, key]));
  const find = (key: string): string => {
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cursor = key;
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor)!;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  for (const [a, b] of edges) {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootA, rootB);
  }
  return new Set(keys.map(find)).size;
}

/**
 * Computes pairwise similarity across the five axes and clusters the result.
 *
 * When an embedding provider is supplied the copy and visual axes blend
 * lexical overlap with embedding cosine, which catches two concepts that say
 * the same thing in different words. Without one the check still works, purely
 * lexically — it is then stricter about wording and blinder to paraphrase.
 */
export async function checkCreativeDiversity(
  concepts: readonly DiversityConcept[],
  options: DiversityOptions = {},
): Promise<DiversityReport> {
  const thresholds = mergeThresholds(options.thresholds);
  const keys = concepts.map((concept) => concept.key);

  let copyVectors: number[][] | null = null;
  let visualVectors: number[][] | null = null;
  if (options.embeddings && concepts.length > 0) {
    copyVectors = await options.embeddings.embed(concepts.map(copyText));
    visualVectors = await options.embeddings.embed(concepts.map(visualText));
  }

  const blend = (lexical: number, vectors: number[][] | null, i: number, j: number): number => {
    if (!vectors || !vectors[i] || !vectors[j]) return lexical;
    const cosine = cosineSimilarity(vectors[i]!, vectors[j]!);
    return (1 - thresholds.embeddingWeight) * lexical + thresholds.embeddingWeight * cosine;
  };

  const pairs: DiversityPair[] = [];
  const edges: [string, string][] = [];

  for (let i = 0; i < concepts.length; i++) {
    for (let j = i + 1; j < concepts.length; j++) {
      const a = concepts[i]!;
      const b = concepts[j]!;

      const hook = lexicalSimilarity(hookText(a), hookText(b));
      const copy = blend(lexicalSimilarity(copyText(a), copyText(b)), copyVectors, i, j);
      const visual = blend(lexicalSimilarity(visualText(a), visualText(b)), visualVectors, i, j);
      // Two concepts that both lean on no proof share nothing — that is an
      // absence, not an overlap, so it must not push the score up.
      const proof =
        a.proofUsed && b.proofUsed ? lexicalSimilarity(a.proofUsed, b.proofUsed) : 0;
      const promise = lexicalSimilarity(a.funnelPromise, b.funnelPromise);
      const samePrinciple = a.principle === b.principle;

      const weighted =
        thresholds.weights.hook * hook +
        thresholds.weights.copy * copy +
        thresholds.weights.visual * visual +
        thresholds.weights.proof * proof +
        thresholds.weights.promise * promise;
      const overall = Math.min(
        1,
        weighted + (samePrinciple ? thresholds.principlePenalty : 0),
      );
      const tooSimilar = overall >= thresholds.pair;

      const axes: Array<[keyof typeof AXIS_LABELS_DE, number]> = [
        ['hook', hook],
        ['copy', copy],
        ['visual', visual],
        ['proof', proof],
        ['promise', promise],
      ];
      const drivers = axes
        .filter(([, value]) => value >= thresholds.pair)
        .map(([axis]) => AXIS_LABELS_DE[axis]);

      pairs.push({
        aKey: a.key,
        bKey: b.key,
        hook,
        copy,
        visual,
        proof,
        promise,
        samePrinciple,
        overall,
        tooSimilar,
        reasonDe: tooSimilar
          ? `${a.key} und ${b.key} sind konzeptionell zu ähnlich${
              drivers.length > 0 ? ` (${drivers.join(', ')})` : ''
            }${samePrinciple ? ` und nutzen beide das Prinzip ${a.principle}` : ''}.`
          : null,
      });

      if (tooSimilar) edges.push([a.key, b.key]);
    }
  }

  const distinctCount = concepts.length === 0 ? 0 : countClusters(keys, edges);
  const usedPrinciples = new Set(concepts.map((concept) => concept.principle));
  const principlesUsed = CREATIVE_PRINCIPLES.filter((principle) => usedPrinciples.has(principle));

  const reasonsDe: string[] = [];
  for (const pair of pairs) {
    if (pair.reasonDe) reasonsDe.push(pair.reasonDe);
  }
  if (principlesUsed.length < concepts.length) {
    reasonsDe.push(
      `Es werden nur ${principlesUsed.length} der sechs Kommunikationsprinzipien genutzt; vorgesehen ist ein eigenes Prinzip je Konzept.`,
    );
  }

  const blocked = distinctCount < thresholds.minDistinctConcepts;
  if (blocked) {
    reasonsDe.unshift(
      `Es liegen nur ${distinctCount} konzeptionell unterschiedliche Creatives vor, benötigt werden ${thresholds.minDistinctConcepts}.`,
    );
  }

  return { pairs, distinctCount, blocked, reasonsDe, principlesUsed, thresholds };
}

/** Throws when a computed report does not clear the launch bar. */
export function assertDiversityReport(report: DiversityReport): void {
  if (!report.blocked) return;
  throw new DomainError('DIVERSITY_INSUFFICIENT', {
    details: {
      distinctCount: report.distinctCount,
      required: report.thresholds.minDistinctConcepts,
      reasonsDe: report.reasonsDe,
    },
  });
}

/**
 * Computes the report and throws `DIVERSITY_INSUFFICIENT` when fewer than the
 * required number of concepts are conceptually distinct.
 */
export async function assertLaunchDiversity(
  concepts: readonly DiversityConcept[],
  options: DiversityOptions = {},
): Promise<DiversityReport> {
  const report = await checkCreativeDiversity(concepts, options);
  assertDiversityReport(report);
  return report;
}
