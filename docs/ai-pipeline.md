# AI pipeline

## What the model is and is not allowed to do

| Allowed | Not allowed |
| --- | --- |
| propose angles, offers, core messages | produce any performance number |
| write German ad copy and funnel text | invent a statistic or a case study |
| emit **validated structured specs** | emit HTML, CSS or JavaScript |
| explain a computed facts object | change a number while explaining it |
| suggest the next hypothesis | decide a budget or an action |
| label a claim `HYPOTHESIS` | promote its own output to `FACT` |

Every one of these is enforced in code, not by prompt wording alone. Prompts
drift; schemas and guards do not.

## Capability-based providers

Business logic never names a model. It asks for a capability:

```ts
interface TextProvider      { generateStructured<T>(req): Promise<StructuredResult<T>> }
interface ImageProvider     { generateImage(req): Promise<ImageResult> }
interface EmbeddingProvider { embed(texts: string[]): Promise<number[][]> }
```

Concrete models come from environment configuration
(`OPENAI_TEXT_MODEL`, `OPENAI_IMAGE_MODEL`, `OPENAI_EMBEDDING_MODEL`, defaulting
to `gpt-5.6-sol`, `gpt-image-2` and `text-embedding-3-large`). Swapping a model
or a provider is a config change plus one adapter — not a search-and-replace
through the campaign logic.

Each capability has two implementations, selected once in a factory from
`resolveProviderMode('OPENAI')`:

- **Live** — the OpenAI Responses API with Structured Outputs.
- **Fixture** — deterministic, seeded from a hash of the input. It returns
  schema-valid, genuinely varied German content: six creative concepts that
  actually pass the diversity checker, a real proposal, real Meta copy. The
  fixture embedding provider produces stable vectors whose cosine similarity is
  meaningfully higher for related text, so angle-distinctness tests are real
  tests rather than assertions about noise.

## The twelve steps

Each step is a separately persisted, versioned, individually re-runnable job.

| # | Step | Output |
| --- | --- | --- |
| 1 | context summarisation | condensed approved brand context |
| 2 | historical similarity search | nearest past campaigns + framing |
| 3 | angle ideation | candidate angles |
| 4 | **angle distinctness check** | `DISTINCT` / `ITERATION` / `TOO_SIMILAR` |
| 5 | offer development | offer spec |
| 6 | core message | the central claim |
| 7 | creative conception | six concepts across six principles |
| 8 | Meta copy | primary text, headline, description, CTA |
| 9 | funnel strategy | 2–3 funnel proposals |
| 10 | spec generation | `MultiStepFormSpec` / `LandingPageSpec` |
| 11 | claims & guardrail check | violations, required labels |
| 12 | final campaign package | validated `CampaignProposal` |

Every job records the model, prompt id, prompt version, input hash and output
hash. That is what makes a generation reproducible and an output traceable back
to the exact prompt that produced it.

### Failure handling

A response that does not validate against the step's Zod schema is a **failed
job**, never a partially applied proposal. One bounded repair retry feeds the
validation errors back to the model; if that also fails, the job ends as
`AI_OUTPUT_INVALID` and the campaign moves to `GENERATION_FAILED` — without
destroying the last successful business state.

## Context isolation

`buildContext()` is the only path from data into a prompt. It assembles
**approved** context only:

brand profile · ICPs · services · problem situations · offers · case studies ·
testimonials · proof points · approved claims · forbidden claims · tone of voice ·
FAQs · historical campaigns · historical learnings · current campaigns and
overlaps

It then asserts the assembled bundle contains no e-mail or phone patterns and
throws if it does. **No personal lead or CRM data is ever sent to OpenAI.** There
is no second code path that could bypass this, which is the point of having one
function.

## Generation rules

- Exactly **six** creative concepts by default; never fewer than **five
  approved, conceptually distinct** concepts before launch.
- **2–3 funnel variants**, of which at least **two** are `MULTI_STEP_FORM` —
  that default comes from known past performance, and an operator can override
  the funnel types before generation.
- Every claim carries either an evidence reference or a visible hypothesis
  label. `claimSpecStrictSchema` refuses anything else.

## Creative diversity

Six variants must not be six headlines on one design. Diversity is checked
programmatically **and** with the model, across five axes:

hook similarity · copy similarity · visual concept · proof used · funnel promise

plus the six mandated communication principles — problem/pain, concrete result,
comparison, proof/case/datapoint, objection handling, contrarian insight.
Concepts sharing a principle are penalised.

Copy similarity combines lexical overlap (token shingles, Jaccard) with
embedding cosine, because the two fail differently: lexical overlap misses a
paraphrase, embeddings miss a near-duplicate that swapped one noun.

If fewer than five concepts are conceptually distinct, the campaign package is
**blocked** with `DIVERSITY_INSUFFICIENT`, naming the offending pairs.

## Angle distinctness

New angles are embedded and compared against the historical index (pgvector,
with metadata filters for recency, angle and offer).

| Max cosine similarity | Verdict |
| --- | --- |
| ≥ 0.93 | `TOO_SIMILAR` — regenerate |
| ≥ 0.82 | `ITERATION` — allowed, but labelled as one |
| below | `DISTINCT` |

Before a new angle is approved, the console shows the most similar historical
campaigns and the concrete differentiation. Running the same angle twice and
calling it a new test is the most expensive mistake in this workflow, and it is
also the easiest one to make.

## Images

`gpt-image-2` produces the **base motif only**. The prompt explicitly asks for no
text, no logos and no UI typography — image models render text unreliably and
off-brand.

All typography — headline, CTA, logo, frames, colour fields — is composed
deterministically by `@am/creative-renderer` with SVG plus sharp, honouring the
brand tokens, measuring and wrapping German text so it never overflows, and
verifying WCAG AA contrast against the backdrop.

Stored per creative: the original image, the final rendered variants, the
prompt, the model, the parameters, the creative version, the aspect ratios and
the hashes. An operator can edit text directly, regenerate the image, replace
the base motif, change the crop or focus, switch template and approve individual
format variants.

## Explanation, not calculation

`@am/experiments` computes the statistics and `@am/recommendations` decides the
action. The model receives a facts object and may write an explanation and a
next hypothesis.

That output is then checked: **any digit sequence in the explanation that is not
present in the supplied facts causes rejection.** The console renders the
explanation visually separated and labelled as an AI explanation, next to the
deterministic summary that is always present.

Learning cards work the same way. The `FACT` / `INDICATION` / `HYPOTHESIS` label
is derived by `deriveConfidence()` from data maturity, attribution coverage and
sample size. The model contributes the possible explanation and the suggested
next test — not the confidence.
