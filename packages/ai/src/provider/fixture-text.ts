import { DomainError } from '@am/domain';
import { hashUnknown, seedFrom } from '../hash';
import {
  fixtureAngleDistinctnessReview,
  fixtureAngleIdeation,
  fixtureCampaignPackage,
  fixtureClaimReview,
  fixtureContextSummary,
  fixtureCoreMessage,
  fixtureCreativeConception,
  fixtureFunnelSpecDraft,
  fixtureFunnelStrategy,
  fixtureHistoryFraming,
  fixtureMetaCopy,
  fixtureMetricExplanation,
  fixtureOfferDevelopment,
} from './fixture-content';
import type { StructuredRequest, StructuredResult, TextProvider } from './types';

/**
 * Deterministic `TextProvider`.
 *
 * The seed is a hash of the request — schema name, system prompt, user prompt —
 * so identical input always produces identical output, and a changed prompt
 * produces a different (still valid) variant. Content comes from
 * `fixture-content`, keyed by the prompt id the pipeline passes as
 * `schemaName`.
 *
 * The fixture answer is validated against the caller's schema exactly like a
 * live response. That is deliberate: a fixture that drifts out of contract must
 * fail the suite, not quietly paper over a schema change.
 */

export interface FixtureTextProviderOptions {
  /** Extra entropy so two providers in one test can differ. */
  seed?: string;
  /**
   * Prompt ids for which the provider returns deliberately invalid output.
   * Drives the repair-retry test without a network stub.
   */
  invalidFor?: readonly string[];
  /**
   * Prompt ids that stay invalid only on the first attempt, so the bounded
   * repair turn can be observed succeeding.
   */
  invalidUntilRepairFor?: readonly string[];
  /** Prompt ids for which the provider simulates a refusal. */
  refuseFor?: readonly string[];
}

type FixtureBuilder = (seed: number, request: StructuredRequest<unknown>) => unknown;

const BUILDERS: Readonly<Record<string, FixtureBuilder>> = {
  'context.summarize': (seed) => fixtureContextSummary(seed),
  'history.similarity_framing': (seed) => fixtureHistoryFraming(seed),
  'angle.ideation': (seed) => fixtureAngleIdeation(seed),
  'angle.distinctness_review': (seed) => fixtureAngleDistinctnessReview(seed),
  'offer.development': (seed) => fixtureOfferDevelopment(seed),
  'message.core': (seed) => fixtureCoreMessage(seed),
  'creative.conception': (seed) => fixtureCreativeConception(seed),
  'creative.meta_copy': (seed) => fixtureMetaCopy(seed),
  'funnel.strategy': (seed) => fixtureFunnelStrategy(seed),
  'funnel.spec_draft': (seed, request) =>
    fixtureFunnelSpecDraft(seed, request.metadata?.funnelKey ?? 'funnel_1'),
  'guardrails.claim_check': (seed) => fixtureClaimReview(seed),
  'campaign.package': (seed) => fixtureCampaignPackage(seed),
  'analytics.explain': (seed) => fixtureMetricExplanation(seed),
};

export class FixtureTextProvider implements TextProvider {
  readonly kind = 'fixture' as const;
  readonly model = 'fixture-text-v1';

  /** Every request this provider saw, in order. Test observation seam. */
  readonly calls: StructuredRequest<unknown>[] = [];

  private readonly options: FixtureTextProviderOptions;
  private readonly attempts = new Map<string, number>();

  constructor(options: FixtureTextProviderOptions = {}) {
    this.options = options;
  }

  /** Number of calls seen for a prompt id, including repair turns. */
  attemptsFor(schemaName: string): number {
    return this.attempts.get(schemaName) ?? 0;
  }

  reset(): void {
    this.calls.length = 0;
    this.attempts.clear();
  }

  generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.calls.push(request as StructuredRequest<unknown>);
    const attempt = (this.attempts.get(request.schemaName) ?? 0) + 1;
    this.attempts.set(request.schemaName, attempt);

    const requestHash = hashUnknown({
      schemaName: request.schemaName,
      system: request.systemPrompt,
      user: request.userPrompt,
      repair: request.repair?.issues ?? null,
    });
    const base = {
      model: this.model,
      usage: null,
      requestHash,
    } as const;

    if (this.options.refuseFor?.includes(request.schemaName)) {
      return Promise.resolve({
        ...base,
        data: null,
        raw: '',
        issues: ['refusal: Die Anfrage wurde vom Modell abgelehnt.'],
        finishReason: 'refusal',
        refusal: 'Die Anfrage wurde vom Modell abgelehnt.',
      });
    }

    const permanentlyInvalid = this.options.invalidFor?.includes(request.schemaName) ?? false;
    const invalidFirstAttempt =
      (this.options.invalidUntilRepairFor?.includes(request.schemaName) ?? false) && attempt === 1;

    if (permanentlyInvalid || invalidFirstAttempt) {
      const raw = JSON.stringify({ unerwartetesFeld: 'Die Antwort passt nicht zum Schema.' });
      const parsed = request.schema.safeParse(JSON.parse(raw));
      return Promise.resolve({
        ...base,
        data: null,
        raw,
        issues: parsed.success
          ? ['(root): Fixture-Fehlerfall erzeugt.']
          : parsed.error.issues.map(
              (issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`,
            ),
        finishReason: 'completed',
        refusal: null,
      });
    }

    const builder = BUILDERS[request.schemaName];
    if (!builder) {
      throw new DomainError('PROVIDER_NOT_CONFIGURED', {
        messageDe: 'Für diesen Schritt liegt kein Fixture-Inhalt vor.',
        details: { schemaName: request.schemaName, available: Object.keys(BUILDERS) },
      });
    }

    // Seeded from the whole request: same input, same output; changed prompt,
    // different but still valid output.
    const seed = seedFrom(
      `${this.options.seed ?? ''}|${request.schemaName}|${request.systemPrompt}|${request.userPrompt}`,
    );
    const value = builder(seed, request as StructuredRequest<unknown>);
    const raw = JSON.stringify(value, null, 2);

    const parsed = request.schema.safeParse(value);
    if (!parsed.success) {
      // A fixture that no longer satisfies its own contract is a bug in this
      // package, not a simulated model failure — say so loudly.
      throw new DomainError('AI_OUTPUT_INVALID', {
        messageDe: 'Der Fixture-Inhalt entspricht nicht mehr dem Schema dieses Schritts.',
        details: {
          schemaName: request.schemaName,
          issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        },
      });
    }

    return Promise.resolve({
      ...base,
      data: parsed.data as T,
      raw,
      issues: [],
      finishReason: 'completed',
      refusal: null,
    });
  }
}
