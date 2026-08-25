/**
 * Beta-Binomial evaluation for binary conversion metrics.
 *
 * Why Bayesian rather than a frequentist two-proportion test: the console has to
 * answer "which arm should we keep?" while a test is still running, and it has
 * to answer it with a number an operator can act on. `P(arm is best)` and
 * `expected loss` are directly interpretable; a p-value peeked at daily is not.
 *
 * Model
 * -----
 * Each arm's conversion rate θ carries a Beta prior (default Beta(1,1) — uniform,
 * i.e. one pseudo-success and one pseudo-failure) and a Binomial likelihood, so
 * the posterior is conjugate:
 *
 *     θ | data ~ Beta(prior.alpha + conversions, prior.beta + trials − conversions)
 *
 * Every quantity below is a functional of those posteriors.
 *
 * Determinism
 * -----------
 * Nothing in this module reads a clock, a global RNG or the environment. The
 * same inputs produce bit-identical outputs on every run and on every machine —
 * a hard requirement, because a recommendation must be reproducible months later
 * during an audit. The 3+-arm path uses a Halton quasi-random sequence, which is
 * a fixed deterministic point set, not a sampled one.
 *
 * No external statistics library is used: `logGamma`, `betacf`, `betainc` and
 * the inverse incomplete beta are implemented here and checked against published
 * reference values in `beta-binomial.test.ts`.
 */

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

/** Parameters of a Beta distribution. Both must be strictly positive. */
export interface BetaParameters {
  alpha: number;
  beta: number;
}

export type BetaPrior = BetaParameters;
export type BetaPosterior = BetaParameters;

/**
 * Uniform prior. Deliberately weak: an informative prior would let a historical
 * assumption quietly outvote the data of the test actually running.
 */
export const DEFAULT_BETA_PRIOR: BetaPrior = { alpha: 1, beta: 1 };

export interface BinaryObservation {
  /** Successes (conversions). */
  successes: number;
  /** Trials (exposures or sessions — chosen once per experiment, never mixed). */
  trials: number;
}

export type ProbabilityBestMethod = 'EXACT_QUADRATURE' | 'HALTON_QMC';

export interface PosteriorComparisonOptions {
  /** Number of quasi-random points for the 3+-arm path. */
  draws?: number;
}

export interface PosteriorComparison {
  /** P(arm k has the highest θ), aligned with the input order. Sums to 1. */
  probabilityBest: number[];
  /** E[(max_j θ_j − θ_k)⁺] in absolute rate units, aligned with the input order. */
  expectedLoss: number[];
  method: ProbabilityBestMethod;
  /** Number of integration nodes / quasi-random points actually used. */
  draws: number;
  /**
   * Conservative absolute error bound on each probability. Callers close to a
   * decision threshold should treat |p − threshold| < errorBound as "too close
   * to call numerically" rather than as a decision.
   */
  errorBound: number;
}

/* -------------------------------------------------------------------------- */
/* logGamma — Lanczos approximation (g = 7, n = 9)                             */
/* -------------------------------------------------------------------------- */

const LANCZOS_G = 7;
const LANCZOS_COEFFICIENTS: readonly number[] = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];

const LOG_SQRT_2PI = 0.5 * Math.log(2 * Math.PI);

/**
 * Natural logarithm of the Gamma function.
 *
 * Lanczos approximation with the reflection formula for x < 0.5. Relative error
 * below ~1e-13 across the range this product uses (counts, never huge shapes).
 */
export function logGamma(x: number): number {
  if (!Number.isFinite(x)) return Number.NaN;
  if (x <= 0 && Number.isInteger(x)) return Number.POSITIVE_INFINITY;

  if (x < 0.5) {
    // Reflection: Γ(x)Γ(1−x) = π / sin(πx)
    return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - logGamma(1 - x);
  }

  const z = x - 1;
  let series = LANCZOS_COEFFICIENTS[0];
  for (let i = 1; i < LANCZOS_COEFFICIENTS.length; i++) {
    series += LANCZOS_COEFFICIENTS[i] / (z + i);
  }
  const t = z + LANCZOS_G + 0.5;
  return LOG_SQRT_2PI + (z + 0.5) * Math.log(t) - t + Math.log(series);
}

/** ln B(a, b) = ln Γ(a) + ln Γ(b) − ln Γ(a+b). */
export function logBeta(a: number, b: number): number {
  return logGamma(a) + logGamma(b) - logGamma(a + b);
}

/* -------------------------------------------------------------------------- */
/* Regularised incomplete beta                                                 */
/* -------------------------------------------------------------------------- */

const BETACF_MAX_ITERATIONS = 400;
const BETACF_EPSILON = 3e-16;
const BETACF_FLOOR = 1e-300;

/**
 * Continued-fraction expansion used by `betainc`, evaluated with the modified
 * Lentz algorithm. Converges quickly for x < (a+1)/(a+b+2); `betainc` applies
 * the symmetry transform outside that range.
 */
export function betacf(a: number, b: number, x: number): number {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;

  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < BETACF_FLOOR) d = BETACF_FLOOR;
  d = 1 / d;
  let h = d;

  for (let m = 1; m <= BETACF_MAX_ITERATIONS; m++) {
    const m2 = 2 * m;

    // Even step.
    let numerator = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + numerator * d;
    if (Math.abs(d) < BETACF_FLOOR) d = BETACF_FLOOR;
    c = 1 + numerator / c;
    if (Math.abs(c) < BETACF_FLOOR) c = BETACF_FLOOR;
    d = 1 / d;
    h *= d * c;

    // Odd step.
    numerator = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + numerator * d;
    if (Math.abs(d) < BETACF_FLOOR) d = BETACF_FLOOR;
    c = 1 + numerator / c;
    if (Math.abs(c) < BETACF_FLOOR) c = BETACF_FLOOR;
    d = 1 / d;
    const delta = d * c;
    h *= delta;

    if (Math.abs(delta - 1) < BETACF_EPSILON) break;
  }

  return h;
}

/**
 * Regularised incomplete beta I_x(a, b) — equivalently the CDF of Beta(a, b).
 *
 * Reference values verified in the tests, e.g. I_0.5(2,3) = 0.6875 and
 * I_x(0.5,0.5) = (2/π)·arcsin(√x).
 */
export function betainc(a: number, b: number, x: number): number {
  if (Number.isNaN(x)) return Number.NaN;
  if (x <= 0) return 0;
  if (x >= 1) return 1;

  const logFront = a * Math.log(x) + b * Math.log(1 - x) - logBeta(a, b);
  const front = Math.exp(logFront);

  if (x < (a + 1) / (a + b + 2)) {
    return (front * betacf(a, b, x)) / a;
  }
  return 1 - (front * betacf(b, a, 1 - x)) / b;
}

/** Log density of Beta(a, b) at x. Kept in log space for large shapes. */
export function betaLogPdf(x: number, a: number, b: number): number {
  if (x <= 0 || x >= 1) return Number.NEGATIVE_INFINITY;
  return (a - 1) * Math.log(x) + (b - 1) * Math.log(1 - x) - logBeta(a, b);
}

export function betaPdf(x: number, a: number, b: number): number {
  const lp = betaLogPdf(x, a, b);
  return lp === Number.NEGATIVE_INFINITY ? 0 : Math.exp(lp);
}

const INV_BETAINC_MAX_ITERATIONS = 40;
const INV_BETAINC_EPSILON = 1e-14;

/**
 * Inverse regularised incomplete beta — the p-quantile of Beta(a, b).
 *
 * Strategy: a closed-form starting point (normal approximation for a,b ≥ 1, a
 * power-law approximation otherwise), then Halley iteration on
 * I_x(a,b) − p = 0, with bisection fallback whenever a step would leave the
 * bracketing interval. Converges to ~1e-14 in a handful of iterations and never
 * escapes (0, 1).
 */
export function invBetainc(a: number, b: number, p: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;

  let lo = 0;
  let hi = 1;
  let x: number;

  if (a >= 1 && b >= 1) {
    // Normal approximation to the Beta quantile (Abramowitz & Stegun 26.2.22
    // for the standard normal quantile, then A&S 26.5.22 for the Beta).
    const pp = p < 0.5 ? p : 1 - p;
    const t = Math.sqrt(-2 * Math.log(pp));
    let z = t - (2.30753 + t * 0.27061) / (1 + t * (0.99229 + t * 0.04481));
    if (p < 0.5) z = -z;
    const al = (z * z - 3) / 6;
    const h = 2 / (1 / (2 * a - 1) + 1 / (2 * b - 1));
    const w =
      (z * Math.sqrt(al + h)) / h -
      (1 / (2 * b - 1) - 1 / (2 * a - 1)) * (al + 5 / 6 - 2 / (3 * h));
    x = a / (a + b * Math.exp(2 * w));
  } else {
    const lna = Math.log(a / (a + b));
    const lnb = Math.log(b / (a + b));
    const t = Math.exp(a * lna) / a;
    const u = Math.exp(b * lnb) / b;
    const w = t + u;
    x = p < t / w ? Math.pow(a * w * p, 1 / a) : 1 - Math.pow(b * w * (1 - p), 1 / b);
  }

  if (!(x > 0) || !(x < 1) || Number.isNaN(x)) x = 0.5;

  for (let i = 0; i < INV_BETAINC_MAX_ITERATIONS; i++) {
    const err = betainc(a, b, x) - p;
    if (err > 0) hi = x;
    else lo = x;

    const pdf = betaPdf(x, a, b);
    let next: number;
    if (pdf > 0 && Number.isFinite(pdf)) {
      const newton = err / pdf;
      // Halley correction using the log-derivative of the density.
      const curvature = (a - 1) / x - (b - 1) / (1 - x);
      const damping = 1 - 0.5 * Math.max(-1, Math.min(1, newton * curvature));
      next = x - newton / (damping === 0 ? 1 : damping);
    } else {
      next = 0.5 * (lo + hi);
    }

    if (!(next > lo) || !(next < hi) || Number.isNaN(next)) {
      next = 0.5 * (lo + hi);
    }

    const step = Math.abs(next - x);
    x = next;
    if (step < INV_BETAINC_EPSILON * Math.max(x, 1e-12)) break;
  }

  return x;
}

/* -------------------------------------------------------------------------- */
/* Posteriors                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Conjugate update. `trials` is clamped to at least `successes` so that a
 * mis-counted upstream row can never produce a negative Beta parameter — the
 * caller is expected to surface that inconsistency as a warning.
 */
export function betaPosterior(
  observation: BinaryObservation,
  prior: BetaPrior = DEFAULT_BETA_PRIOR,
): BetaPosterior {
  const successes = Math.max(0, observation.successes);
  const trials = Math.max(successes, Math.max(0, observation.trials));
  return {
    alpha: prior.alpha + successes,
    beta: prior.beta + (trials - successes),
  };
}

export function posteriorMean(posterior: BetaParameters): number {
  return posterior.alpha / (posterior.alpha + posterior.beta);
}

export function posteriorVariance(posterior: BetaParameters): number {
  const { alpha, beta } = posterior;
  const s = alpha + beta;
  return (alpha * beta) / (s * s * (s + 1));
}

/**
 * Equal-tailed credible interval carrying `mass` of the posterior — e.g.
 * `mass = 0.95` returns the 2.5 % and 97.5 % quantiles.
 *
 * Equal-tailed rather than highest-density on purpose: it is monotone in the
 * data, trivially reproducible, and matches how the interval is read in the UI
 * ("2,5 % / 97,5 %").
 */
export function credibleInterval(alpha: number, beta: number, mass = 0.95): [number, number] {
  const clampedMass = Math.min(Math.max(mass, 0), 1 - 1e-12);
  const tail = (1 - clampedMass) / 2;
  return [invBetainc(alpha, beta, tail), invBetainc(alpha, beta, 1 - tail)];
}

/**
 * Relative lift of a variant against the control, computed on posterior means
 * rather than raw rates: at low volume the raw ratio swings wildly, and the
 * shrunk estimate is what the decision thresholds were calibrated against.
 *
 * Returns `null` when the control's posterior mean is zero — an undefined lift
 * is never reported as 0 % or ∞.
 */
export function relativeLift(variant: BetaParameters, control: BetaParameters): number | null {
  const controlMean = posteriorMean(control);
  if (!(controlMean > 0)) return null;
  return (posteriorMean(variant) - controlMean) / controlMean;
}

/* -------------------------------------------------------------------------- */
/* Numerical integration (2 arms)                                              */
/* -------------------------------------------------------------------------- */

/** 16-point Gauss-Legendre nodes/weights on [-1, 1] (positive half). */
const GL_NODES: readonly number[] = [
  0.0950125098376374, 0.2816035507792589, 0.4580167776572274, 0.6178762444026438,
  0.755404408355003, 0.8656312023878318, 0.9445750230732326, 0.9894009349916499,
];
const GL_WEIGHTS: readonly number[] = [
  0.1894506104550685, 0.1826034150449236, 0.1691565193950025, 0.1495959888165767,
  0.1246289712555339, 0.0951585116824928, 0.0622535239386479, 0.0271524594117541,
];

/** Panels for the composite rule. 64 × 16 nodes is far beyond what is needed. */
const QUADRATURE_PANELS = 64;
/** Posterior mass ignored in each tail before integrating. */
const QUADRATURE_TAIL_MASS = 1e-10;
/** Error bound of the two-arm path: quadrature error + neglected tails. */
const QUADRATURE_ERROR_BOUND = 1e-9;

/**
 * ∫ f(x)·pdf_{a,b}(x) dx over the effective support of Beta(a, b).
 *
 * The integration range is the (1 − 2·TAIL) equal-tailed interval; the neglected
 * tails contribute at most TAIL·sup|f| each, which is added back evaluated at
 * the boundary. `f` must be bounded — every use here passes a CDF product or a
 * truncated expectation.
 */
function integrateAgainstBeta(a: number, b: number, f: (x: number) => number): number {
  const lo = invBetainc(a, b, QUADRATURE_TAIL_MASS);
  const hi = invBetainc(a, b, 1 - QUADRATURE_TAIL_MASS);
  if (!(hi > lo)) return f(lo);

  const panelWidth = (hi - lo) / QUADRATURE_PANELS;
  const half = panelWidth / 2;
  let total = 0;

  for (let panel = 0; panel < QUADRATURE_PANELS; panel++) {
    const centre = lo + panelWidth * panel + half;
    for (let k = 0; k < GL_NODES.length; k++) {
      const offset = half * GL_NODES[k];
      const weight = GL_WEIGHTS[k] * half;
      const xa = centre - offset;
      const xb = centre + offset;
      total += weight * (betaPdf(xa, a, b) * f(xa) + betaPdf(xb, a, b) * f(xb));
    }
  }

  // Tail contributions, evaluated at the truncation boundaries.
  total += QUADRATURE_TAIL_MASS * (f(lo) + f(hi));
  return total;
}

/** P(θ_a > θ_b) by direct integration of pdf_a · cdf_b. */
function probabilityGreaterExact(a: BetaParameters, b: BetaParameters): number {
  const p = integrateAgainstBeta(a.alpha, a.beta, (x) => betainc(b.alpha, b.beta, x));
  return Math.min(1, Math.max(0, p));
}

/**
 * E[(θ_other − θ_self)⁺], the expected loss of choosing `self` when `other` is
 * in fact better. Uses the identity ∫₀^y x·pdf_{a,b}(x) dx = mean·I_y(a+1, b),
 * which turns the double integral into a single one.
 */
function expectedLossExact(self: BetaParameters, other: BetaParameters): number {
  const selfMean = posteriorMean(self);
  const loss = integrateAgainstBeta(
    other.alpha,
    other.beta,
    (y) =>
      y * betainc(self.alpha, self.beta, y) - selfMean * betainc(self.alpha + 1, self.beta, y),
  );
  return Math.max(0, loss);
}

/* -------------------------------------------------------------------------- */
/* Quasi-Monte-Carlo (3+ arms)                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Halton bases. One prime per arm, so no two arms share a coordinate sequence.
 * Eight arms is well past anything the product allows (`allocation` weights make
 * more than a handful of arms statistically pointless anyway).
 */
const HALTON_BASES: readonly number[] = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37];

/**
 * Fixed burn-in. The first Halton points are strongly correlated across bases;
 * skipping a prime number of them is the standard remedy and keeps the point set
 * completely deterministic.
 */
const HALTON_SKIP = 1021;

/** Default point count for the QMC path — 2^15, a good accuracy/latency trade. */
export const DEFAULT_QMC_DRAWS = 32768;

/**
 * Practical absolute error bound of the QMC path at the default point count.
 *
 * The theoretical Koksma-Hlawka bound is not computable here (the variation of
 * the indicator "arm k is the maximum" is unbounded in the classical sense), so
 * this is an empirical bound: across the arm configurations exercised in the
 * tests, three to six arms at 32 768 points reproduce the exact two-arm
 * quadrature to better than 3·10⁻⁴. 2·10⁻³ is quoted as the safety margin, and
 * `evaluate.ts` refuses to call a winner when the win probability sits inside
 * that margin around the threshold.
 */
export const QMC_ERROR_BOUND = 2e-3;

/** Radical-inverse function φ_base(index) — the Halton coordinate. */
export function haltonPoint(index: number, base: number): number {
  let fraction = 1;
  let result = 0;
  let i = index;
  while (i > 0) {
    fraction /= base;
    result += fraction * (i % base);
    i = Math.floor(i / base);
  }
  return result;
}

function compareQmc(arms: readonly BetaParameters[], draws: number): PosteriorComparison {
  const armCount = arms.length;
  const counts = new Array<number>(armCount).fill(0);
  const lossSums = new Array<number>(armCount).fill(0);
  const sample = new Array<number>(armCount).fill(0);

  for (let n = 0; n < draws; n++) {
    const index = HALTON_SKIP + n;
    let bestIndex = 0;
    let bestValue = -1;

    for (let k = 0; k < armCount; k++) {
      const u = haltonPoint(index, HALTON_BASES[k % HALTON_BASES.length]);
      const theta = invBetainc(arms[k].alpha, arms[k].beta, u);
      sample[k] = theta;
      // Strict `>` keeps the tie-break at the lowest arm index — deterministic.
      if (theta > bestValue) {
        bestValue = theta;
        bestIndex = k;
      }
    }

    counts[bestIndex] += 1;
    for (let k = 0; k < armCount; k++) {
      lossSums[k] += bestValue - sample[k];
    }
  }

  return {
    probabilityBest: counts.map((c) => c / draws),
    expectedLoss: lossSums.map((s) => s / draws),
    method: 'HALTON_QMC',
    draws,
    errorBound: QMC_ERROR_BOUND,
  };
}

/* -------------------------------------------------------------------------- */
/* Public comparison API                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Full posterior comparison across arms.
 *
 * - 2 arms  → exact numerical integration (composite Gauss-Legendre), error
 *             bound 1e-9, probabilities summing to exactly 1.
 * - 3+ arms → seeded Halton quasi-Monte-Carlo, deterministic point set,
 *             empirical error bound `QMC_ERROR_BOUND`. Probabilities sum to
 *             exactly 1 by construction (they are counts over the same points).
 */
export function comparePosteriors(
  arms: readonly BetaParameters[],
  options: PosteriorComparisonOptions = {},
): PosteriorComparison {
  if (arms.length === 0) {
    return {
      probabilityBest: [],
      expectedLoss: [],
      method: 'EXACT_QUADRATURE',
      draws: 0,
      errorBound: 0,
    };
  }

  if (arms.length === 1) {
    return {
      probabilityBest: [1],
      expectedLoss: [0],
      method: 'EXACT_QUADRATURE',
      draws: 0,
      errorBound: 0,
    };
  }

  if (arms.length === 2) {
    const first = probabilityGreaterExact(arms[0], arms[1]);
    return {
      probabilityBest: [first, 1 - first],
      expectedLoss: [expectedLossExact(arms[0], arms[1]), expectedLossExact(arms[1], arms[0])],
      method: 'EXACT_QUADRATURE',
      draws: QUADRATURE_PANELS * GL_NODES.length * 2,
      errorBound: QUADRATURE_ERROR_BOUND,
    };
  }

  const draws = Math.max(1024, Math.floor(options.draws ?? DEFAULT_QMC_DRAWS));
  return compareQmc(arms, draws);
}

/** P(arm k is the best), aligned with the input order. Sums to 1. */
export function probabilityBest(
  arms: readonly BetaParameters[],
  options: PosteriorComparisonOptions = {},
): number[] {
  return comparePosteriors(arms, options).probabilityBest;
}

/**
 * Expected loss of committing to each arm, in absolute conversion-rate units:
 * E[(max_j θ_j − θ_k)⁺]. A near-zero expected loss is the honest way to say
 * "picking this arm costs nothing even if it is not truly the best".
 */
export function expectedLoss(
  arms: readonly BetaParameters[],
  options: PosteriorComparisonOptions = {},
): number[] {
  return comparePosteriors(arms, options).expectedLoss;
}
