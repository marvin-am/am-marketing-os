import { uuidSchema } from '@am/domain';
import { describe, expect, it } from 'vitest';
import { deterministicUuid, recommendationId } from './ids';

describe('deterministicUuid', () => {
  it('produces a UUID the domain schema accepts', () => {
    for (const parts of [
      ['a'],
      ['recommendation', 'campaign-1', 'SCALE_BUDGET', 'scope'],
      ['', ''],
      ['ä', 'ö', 'ü', '🙂'],
    ]) {
      const id = deterministicUuid(parts);
      expect(() => uuidSchema.parse(id)).not.toThrow();
    }
  });

  it('marks the id as version 8 — derived, not random', () => {
    const id = deterministicUuid(['x', 'y']);
    expect(id[14]).toBe('8');
    expect('89ab').toContain(id[19]);
  });

  it('is stable across calls', () => {
    const parts = ['recommendation', 'campaign-1', 'SCALE_BUDGET', 'scope'];
    expect(deterministicUuid(parts)).toBe(deterministicUuid(parts));
    expect(deterministicUuid([...parts])).toBe(deterministicUuid(parts));
  });

  it('separates parts so concatenations cannot collide', () => {
    expect(deterministicUuid(['ab', 'c'])).not.toBe(deterministicUuid(['a', 'bc']));
  });

  it('avalanches — neighbouring inputs produce unrelated ids', () => {
    const a = deterministicUuid(['scope-1']);
    const b = deterministicUuid(['scope-2']);
    expect(a).not.toBe(b);
    // Nothing beyond the fixed version/variant nibbles should match position-wise.
    const shared = [...a].filter((char, index) => char === b[index]).length;
    expect(shared).toBeLessThan(20);
  });

  it('produces distinct ids across a large key space', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 5_000; i++) ids.add(deterministicUuid(['campaign', String(i)]));
    expect(ids.size).toBe(5_000);
  });
});

describe('recommendationId', () => {
  it('is a pure function of campaign, rule and scope', () => {
    expect(recommendationId('c1', 'SCALE_BUDGET', 's1')).toBe(
      recommendationId('c1', 'SCALE_BUDGET', 's1'),
    );
  });

  it('changes when any component changes', () => {
    const base = recommendationId('c1', 'SCALE_BUDGET', 's1');
    expect(recommendationId('c2', 'SCALE_BUDGET', 's1')).not.toBe(base);
    expect(recommendationId('c1', 'DECREASE_BUDGET_ON_GUARDRAIL_BREACH', 's1')).not.toBe(base);
    expect(recommendationId('c1', 'SCALE_BUDGET', 's2')).not.toBe(base);
  });
});
