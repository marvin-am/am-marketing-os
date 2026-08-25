import { describe, expect, it } from 'vitest';
import {
  betaPosterior,
  betacf,
  betainc,
  betaPdf,
  comparePosteriors,
  credibleInterval,
  DEFAULT_BETA_PRIOR,
  expectedLoss,
  haltonPoint,
  invBetainc,
  logBeta,
  logGamma,
  posteriorMean,
  probabilityBest,
  relativeLift,
  type BetaParameters,
} from './beta-binomial';

/* -------------------------------------------------------------------------- */
/* Independent reference implementations used only by these tests              */
/* -------------------------------------------------------------------------- */

/**
 * Exact closed form for P(X > Y) with X ~ Beta(a,b), Y ~ Beta(c,d) and integer
 * a (Cook, "Exact calculation of Beta inequalities"):
 *
 *   P(X > Y) = Σ_{i=0}^{a−1} B(c+i, d+b) / [ (b+i)·B(1+i, b)·B(c, d) ]
 *
 * Completely independent of the quadrature under test. Self-checked below
 * against three cases that can be integrated by hand.
 */
function exactProbabilityGreater(x: BetaParameters, y: BetaParameters): number {
  const a = x.alpha;
  const b = x.beta;
  const c = y.alpha;
  const d = y.beta;
  let total = 0;
  for (let i = 0; i < a; i++) {
    const logTerm = logBeta(c + i, d + b) - Math.log(b + i) - logBeta(1 + i, b) - logBeta(c, d);
    total += Math.exp(logTerm);
  }
  return total;
}

/** CDF of Beta(0.5, 0.5): I_x(0.5,0.5) = (2/π)·arcsin(√x). */
const arcsineCdf = (x: number): number => (2 / Math.PI) * Math.asin(Math.sqrt(x));
/** Quantile of Beta(0.5, 0.5): sin²(πp/2). */
const arcsineQuantile = (p: number): number => Math.sin((Math.PI * p) / 2) ** 2;

describe('logGamma', () => {
  it('matches published reference values', () => {
    // ln Γ(1/2) = ln √π
    expect(logGamma(0.5)).toBeCloseTo(0.5723649429247001, 12);
    expect(logGamma(1)).toBeCloseTo(0, 12);
    expect(logGamma(2)).toBeCloseTo(0, 12);
    // ln Γ(3) = ln 2!
    expect(logGamma(3)).toBeCloseTo(0.6931471805599453, 12);
    // ln Γ(6) = ln 120
    expect(logGamma(6)).toBeCloseTo(4.787491742782046, 11);
    // ln Γ(10) = ln 362880
    expect(logGamma(10)).toBeCloseTo(12.801827480081469, 10);
    // ln Γ(100) = ln 99!
    expect(logGamma(100)).toBeCloseTo(359.1342053695754, 8);
  });

  it('reproduces the factorial recursion', () => {
    for (let n = 1; n <= 12; n++) {
      let factorial = 1;
      for (let k = 2; k < n; k++) factorial *= k;
      expect(logGamma(n)).toBeCloseTo(Math.log(factorial), 10);
    }
  });
});

describe('logBeta', () => {
  it('matches B(2,3) = 1/12', () => {
    expect(logBeta(2, 3)).toBeCloseTo(Math.log(1 / 12), 12);
  });

  it('is symmetric', () => {
    expect(logBeta(3.5, 7.25)).toBeCloseTo(logBeta(7.25, 3.5), 12);
  });
});

describe('betainc', () => {
  it('matches published reference values', () => {
    // Uniform.
    expect(betainc(1, 1, 0.5)).toBeCloseTo(0.5, 12);
    expect(betainc(1, 1, 0.25)).toBeCloseTo(0.25, 12);

    // Beta(2,3) CDF = 6x² − 8x³ + 3x⁴; at x = 0.5 that is 0.6875 exactly.
    expect(betainc(2, 3, 0.5)).toBeCloseTo(0.6875, 12);

    // Arcsine law.
    expect(betainc(0.5, 0.5, 0.25)).toBeCloseTo(1 / 3, 12);
    expect(betainc(0.5, 0.5, 0.5)).toBeCloseTo(0.5, 12);

    // Binomial identity I_x(k, n−k+1) = P(Bin(n, x) ≥ k).
    // I_0.3(2,4) = P(Bin(5, 0.3) ≥ 2) = 0.47178
    expect(betainc(2, 4, 0.3)).toBeCloseTo(0.47178, 10);
    // I_0.9(10,3) = P(Bin(12, 0.9) ≥ 10) = 0.8891300223
    expect(betainc(10, 3, 0.9)).toBeCloseTo(0.8891300223, 9);
  });

  it('reproduces the Beta(2,3) polynomial CDF across the range', () => {
    for (const x of [0.05, 0.2, 0.37, 0.61, 0.84, 0.99]) {
      const exact = 6 * x ** 2 - 8 * x ** 3 + 3 * x ** 4;
      expect(betainc(2, 3, x)).toBeCloseTo(exact, 11);
    }
  });

  it('satisfies the symmetry I_x(a,b) = 1 − I_{1−x}(b,a)', () => {
    for (const [a, b, x] of [
      [3, 7, 0.2],
      [12.5, 4.25, 0.8],
      [200, 4800, 0.04],
    ]) {
      expect(betainc(a, b, x)).toBeCloseTo(1 - betainc(b, a, 1 - x), 11);
    }
  });

  it('clamps outside [0,1] instead of returning NaN', () => {
    expect(betainc(2, 3, -1)).toBe(0);
    expect(betainc(2, 3, 0)).toBe(0);
    expect(betainc(2, 3, 1)).toBe(1);
    expect(betainc(2, 3, 4)).toBe(1);
  });

  it('exposes a converging continued fraction', () => {
    // betacf is the raw expansion; betainc composes it with the prefactor.
    const a = 4;
    const b = 9;
    const x = 0.2;
    const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - logBeta(a, b));
    expect((front * betacf(a, b, x)) / a).toBeCloseTo(betainc(a, b, x), 12);
  });
});

describe('invBetainc', () => {
  it('matches the arcsine quantile in closed form', () => {
    for (const p of [0.01, 0.025, 0.1, 0.5, 0.9, 0.975, 0.99]) {
      expect(invBetainc(0.5, 0.5, p)).toBeCloseTo(arcsineQuantile(p), 10);
      expect(arcsineCdf(invBetainc(0.5, 0.5, p))).toBeCloseTo(p, 10);
    }
  });

  it('inverts betainc for a wide range of shapes', () => {
    const shapes: [number, number][] = [
      [1, 1],
      [2, 3],
      [0.5, 0.5],
      [10, 3],
      [21, 981],
      [1000, 25000],
    ];
    for (const [a, b] of shapes) {
      for (const p of [1e-6, 0.001, 0.025, 0.25, 0.5, 0.75, 0.975, 0.999]) {
        const x = invBetainc(a, b, p);
        expect(x).toBeGreaterThan(0);
        expect(x).toBeLessThan(1);
        expect(betainc(a, b, x)).toBeCloseTo(p, 9);
      }
    }
  });

  it('returns the boundaries for degenerate probabilities', () => {
    expect(invBetainc(3, 4, 0)).toBe(0);
    expect(invBetainc(3, 4, 1)).toBe(1);
  });
});

describe('credibleInterval', () => {
  it('is exactly [0.025, 0.975] for the uniform posterior at 95 %', () => {
    const [lo, hi] = credibleInterval(1, 1, 0.95);
    expect(lo).toBeCloseTo(0.025, 10);
    expect(hi).toBeCloseTo(0.975, 10);
  });

  it('matches the closed-form arcsine interval', () => {
    const [lo, hi] = credibleInterval(0.5, 0.5, 0.95);
    expect(lo).toBeCloseTo(arcsineQuantile(0.025), 10);
    expect(hi).toBeCloseTo(arcsineQuantile(0.975), 10);
  });

  it('carries the requested posterior mass', () => {
    const [lo, hi] = credibleInterval(21, 981, 0.9);
    expect(betainc(21, 981, hi) - betainc(21, 981, lo)).toBeCloseTo(0.9, 9);
    expect(lo).toBeLessThan(21 / 1002);
    expect(hi).toBeGreaterThan(21 / 1002);
  });

  it('narrows as evidence accumulates', () => {
    const small = credibleInterval(11, 91, 0.95);
    const large = credibleInterval(101, 901, 0.95);
    expect(large[1] - large[0]).toBeLessThan(small[1] - small[0]);
  });

  it('is symmetric around 0.5 for a symmetric posterior', () => {
    const [lo, hi] = credibleInterval(40, 40, 0.95);
    expect(lo + hi).toBeCloseTo(1, 10);
  });
});

describe('betaPosterior', () => {
  it('applies the conjugate update to the default uniform prior', () => {
    expect(betaPosterior({ successes: 20, trials: 200 })).toEqual({ alpha: 21, beta: 181 });
    expect(DEFAULT_BETA_PRIOR).toEqual({ alpha: 1, beta: 1 });
  });

  it('accepts a configurable prior', () => {
    expect(betaPosterior({ successes: 5, trials: 50 }, { alpha: 2, beta: 8 })).toEqual({
      alpha: 7,
      beta: 53,
    });
  });

  it('never produces a non-positive parameter from inconsistent counters', () => {
    const posterior = betaPosterior({ successes: 10, trials: 4 });
    expect(posterior.alpha).toBeGreaterThan(0);
    expect(posterior.beta).toBeGreaterThan(0);
  });
});

describe('relativeLift', () => {
  it('compares posterior means', () => {
    const control = betaPosterior({ successes: 20, trials: 1000 });
    const variant = betaPosterior({ successes: 30, trials: 1000 });
    const lift = relativeLift(variant, control);
    expect(lift).not.toBeNull();
    expect(lift as number).toBeCloseTo(
      (posteriorMean(variant) - posteriorMean(control)) / posteriorMean(control),
      12,
    );
    expect(lift as number).toBeGreaterThan(0.4);
  });

  it('returns null rather than infinity for a zero-mean control', () => {
    expect(relativeLift({ alpha: 5, beta: 5 }, { alpha: 0, beta: 10 })).toBeNull();
  });
});

describe('exactProbabilityGreater (test reference)', () => {
  it('reproduces three hand-integrable cases', () => {
    // Both uniform → 1/2.
    expect(exactProbabilityGreater({ alpha: 1, beta: 1 }, { alpha: 1, beta: 1 })).toBeCloseTo(
      0.5,
      12,
    );
    // X ~ Beta(2,1) (density 2x) against a uniform Y → E[X] = 2/3.
    expect(exactProbabilityGreater({ alpha: 2, beta: 1 }, { alpha: 1, beta: 1 })).toBeCloseTo(
      2 / 3,
      12,
    );
    // X ~ Beta(2,2) against a uniform Y → E[X] = 1/2.
    expect(exactProbabilityGreater({ alpha: 2, beta: 2 }, { alpha: 1, beta: 1 })).toBeCloseTo(
      0.5,
      12,
    );
  });
});

describe('probabilityBest — two arms (exact quadrature)', () => {
  it('is 0.5 for identical posteriors', () => {
    const arms = [betaPosterior({ successes: 40, trials: 400 }), betaPosterior({ successes: 40, trials: 400 })];
    const p = probabilityBest(arms);
    expect(p[0]).toBeCloseTo(0.5, 8);
    expect(p[1]).toBeCloseTo(0.5, 8);
  });

  it('matches the exact closed-form Beta inequality', () => {
    const cases: [BetaParameters, BetaParameters][] = [
      [betaPosterior({ successes: 30, trials: 1000 }), betaPosterior({ successes: 20, trials: 1000 })],
      [betaPosterior({ successes: 5, trials: 60 }), betaPosterior({ successes: 12, trials: 55 })],
      [betaPosterior({ successes: 210, trials: 4000 }), betaPosterior({ successes: 180, trials: 4100 })],
      [betaPosterior({ successes: 0, trials: 200 }), betaPosterior({ successes: 3, trials: 190 })],
    ];
    for (const [a, b] of cases) {
      const [pa, pb] = probabilityBest([a, b]);
      expect(pa).toBeCloseTo(exactProbabilityGreater(a, b), 8);
      expect(pa + pb).toBeCloseTo(1, 12);
    }
  });

  it('reports the method and error bound it used', () => {
    const result = comparePosteriors([
      betaPosterior({ successes: 30, trials: 1000 }),
      betaPosterior({ successes: 20, trials: 1000 }),
    ]);
    expect(result.method).toBe('EXACT_QUADRATURE');
    expect(result.errorBound).toBeLessThanOrEqual(1e-9);
  });

  it('is deterministic across repeated runs', () => {
    const arms = [betaPosterior({ successes: 31, trials: 903 }), betaPosterior({ successes: 44, trials: 911 })];
    const first = probabilityBest(arms);
    const second = probabilityBest(arms);
    const third = probabilityBest([...arms]);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });
});

describe('probabilityBest — three or more arms (Halton QMC)', () => {
  const arms = [
    betaPosterior({ successes: 30, trials: 1000 }),
    betaPosterior({ successes: 20, trials: 1000 }),
    betaPosterior({ successes: 24, trials: 1000 }),
  ];

  it('is deterministic across repeated runs', () => {
    const first = probabilityBest(arms);
    const second = probabilityBest(arms);
    expect(second).toEqual(first);
    expect(probabilityBest([...arms])).toEqual(first);
  });

  it('sums to exactly 1 over the arms', () => {
    const p = probabilityBest(arms);
    expect(p).toHaveLength(3);
    expect(p.reduce((sum, v) => sum + v, 0)).toBeCloseTo(1, 12);
  });

  it('splits evenly across identical arms', () => {
    const identical = [
      betaPosterior({ successes: 50, trials: 500 }),
      betaPosterior({ successes: 50, trials: 500 }),
      betaPosterior({ successes: 50, trials: 500 }),
    ];
    for (const p of probabilityBest(identical)) {
      expect(p).toBeGreaterThan(0.3);
      expect(p).toBeLessThan(0.37);
    }
  });

  it('agrees with the exact two-arm result when a third arm is hopeless', () => {
    const a = betaPosterior({ successes: 30, trials: 1000 });
    const b = betaPosterior({ successes: 20, trials: 1000 });
    const hopeless = betaPosterior({ successes: 0, trials: 200000 });
    const qmc = probabilityBest([a, b, hopeless]);
    expect(qmc[2]).toBeLessThan(1e-6);
    expect(qmc[0]).toBeCloseTo(exactProbabilityGreater(a, b), 2);
  });

  it('gives a dominant arm a near-certain probability', () => {
    const p = probabilityBest([
      betaPosterior({ successes: 400, trials: 2000 }),
      betaPosterior({ successes: 100, trials: 2000 }),
      betaPosterior({ successes: 90, trials: 2000 }),
      betaPosterior({ successes: 110, trials: 2000 }),
    ]);
    expect(p[0]).toBeGreaterThan(0.999);
  });

  it('reports the QMC method, point count and error bound', () => {
    const result = comparePosteriors(arms);
    expect(result.method).toBe('HALTON_QMC');
    expect(result.draws).toBe(32768);
    expect(result.errorBound).toBe(2e-3);
  });

  it('honours an explicit draw count', () => {
    const result = comparePosteriors(arms, { draws: 4096 });
    expect(result.draws).toBe(4096);
  });
});

describe('haltonPoint', () => {
  it('produces the classic van der Corput sequence in base 2', () => {
    expect(haltonPoint(1, 2)).toBeCloseTo(0.5, 12);
    expect(haltonPoint(2, 2)).toBeCloseTo(0.25, 12);
    expect(haltonPoint(3, 2)).toBeCloseTo(0.75, 12);
    expect(haltonPoint(4, 2)).toBeCloseTo(0.125, 12);
  });

  it('produces the base-3 sequence', () => {
    expect(haltonPoint(1, 3)).toBeCloseTo(1 / 3, 12);
    expect(haltonPoint(2, 3)).toBeCloseTo(2 / 3, 12);
    expect(haltonPoint(3, 3)).toBeCloseTo(1 / 9, 12);
  });
});

describe('expectedLoss', () => {
  it('satisfies E[(b−a)⁺] − E[(a−b)⁺] = mean(b) − mean(a)', () => {
    const a = betaPosterior({ successes: 30, trials: 1000 });
    const b = betaPosterior({ successes: 20, trials: 1000 });
    const [lossA, lossB] = expectedLoss([a, b]);
    expect(lossA - lossB).toBeCloseTo(posteriorMean(b) - posteriorMean(a), 8);
  });

  it('is (near) zero for a clearly winning arm and positive for the loser', () => {
    const [winner, loser] = expectedLoss([
      betaPosterior({ successes: 400, trials: 2000 }),
      betaPosterior({ successes: 100, trials: 2000 }),
    ]);
    expect(winner).toBeLessThan(1e-6);
    expect(loser).toBeGreaterThan(0.14);
  });

  it('is non-negative for every arm in the multi-arm path', () => {
    const losses = expectedLoss([
      betaPosterior({ successes: 30, trials: 1000 }),
      betaPosterior({ successes: 20, trials: 1000 }),
      betaPosterior({ successes: 24, trials: 1000 }),
    ]);
    for (const loss of losses) expect(loss).toBeGreaterThanOrEqual(0);
  });
});

describe('betaPdf', () => {
  it('integrates to 1 over the unit interval', () => {
    // Coarse Riemann check — the point is that the normalisation is right.
    let total = 0;
    const steps = 20000;
    for (let i = 0; i < steps; i++) {
      const x = (i + 0.5) / steps;
      total += betaPdf(x, 4, 9) / steps;
    }
    expect(total).toBeCloseTo(1, 5);
  });

  it('is zero outside the support', () => {
    expect(betaPdf(0, 2, 3)).toBe(0);
    expect(betaPdf(1, 2, 3)).toBe(0);
  });
});
