/**
 * `@am/ai` — the OpenAI adapter layer, prompt registry and campaign pipeline.
 *
 * Four ideas hold this package together:
 *
 * 1. **Capabilities, not models.** Feature code asks for a `TextProvider`, an
 *    `ImageProvider` or an `EmbeddingProvider`. Which model serves a capability
 *    lives in `@am/config`; no model id appears in business logic.
 * 2. **Structured output or nothing.** Every generation is validated against a
 *    Zod schema at the provider boundary. An unparseable response is a failed
 *    job, never a partially applied proposal, and there is exactly one bounded
 *    repair turn before the job fails with `AI_OUTPUT_INVALID`.
 * 3. **Data beats model opinion.** Similarity, diversity, budgets, runtimes and
 *    thresholds are computed here. The model explains and hypothesises; it never
 *    produces a number. `explainMetrics` enforces that by checking the answer
 *    against the supplied facts.
 * 4. **Context isolation.** `buildContext()` is the only path from stored data
 *    into a prompt, and it refuses anything that looks like lead, contact or
 *    CRM data.
 *
 * ```ts
 * const deps = { text: getTextProvider(), embeddings: getEmbeddingProvider() };
 * const { proposal, diversity, jobs } = await runCampaignPipeline(
 *   { bundle, briefDe, budget: { dailyBudgetMinor: 5_000, testDays: 14 } },
 *   deps,
 * );
 * ```
 */

export * from './hash';
export * from './text';
export * from './json-schema';
export * from './provider';
export * from './prompts';
export * from './pipeline';
export * from './diversity';
export * from './similarity';
export * from './explain';
