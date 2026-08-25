import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { allocationShares, assignArm, bucketFor, isAllocationChangeSafe } from './assignment';

const SALT = 'experiment-salt-2026-03';
const EXPERIMENT_ID = randomUUID();

const CONTROL = randomUUID();
const VARIANT = randomUUID();
const THIRD = randomUUID();

const EVEN_ARMS = [
  { id: CONTROL, allocation: 0.5 },
  { id: VARIANT, allocation: 0.5 },
];

function visitors(count: number): string[] {
  return Array.from({ length: count }, () => randomUUID());
}

describe('assignArm', () => {
  it('is stable for 10 000 visitors across repeated calls', () => {
    const population = visitors(10_000);
    const first = new Map<string, string>();

    for (const visitorId of population) {
      first.set(
        visitorId,
        assignArm({ visitorId, experimentId: EXPERIMENT_ID, salt: SALT, arms: EVEN_ARMS }).armId,
      );
    }

    // Reload, return visit, another server instance — same answer every time.
    for (const visitorId of population) {
      const again = assignArm({
        visitorId,
        experimentId: EXPERIMENT_ID,
        salt: SALT,
        arms: EVEN_ARMS,
      });
      expect(again.armId).toBe(first.get(visitorId));
      expect(again.bucket).toBeGreaterThanOrEqual(0);
      expect(again.bucket).toBeLessThan(1);
    }
  });

  it('splits 50/50 within tolerance over 10 000 visitors', () => {
    const counts = { [CONTROL]: 0, [VARIANT]: 0 } as Record<string, number>;
    for (const visitorId of visitors(10_000)) {
      counts[assignArm({ visitorId, experimentId: EXPERIMENT_ID, salt: SALT, arms: EVEN_ARMS }).armId] += 1;
    }
    expect(counts[CONTROL] / 10_000).toBeGreaterThan(0.47);
    expect(counts[CONTROL] / 10_000).toBeLessThan(0.53);
    expect(counts[CONTROL] + (counts[VARIANT] as number)).toBe(10_000);
  });

  it('honours unequal weights', () => {
    const arms = [
      { id: CONTROL, allocation: 0.7 },
      { id: VARIANT, allocation: 0.2 },
      { id: THIRD, allocation: 0.1 },
    ];
    const counts: Record<string, number> = { [CONTROL]: 0, [VARIANT]: 0, [THIRD]: 0 };
    for (const visitorId of visitors(20_000)) {
      counts[assignArm({ visitorId, experimentId: EXPERIMENT_ID, salt: SALT, arms }).armId] += 1;
    }

    expect((counts[CONTROL] as number) / 20_000).toBeCloseTo(0.7, 1);
    expect((counts[VARIANT] as number) / 20_000).toBeCloseTo(0.2, 1);
    expect((counts[THIRD] as number) / 20_000).toBeCloseTo(0.1, 1);
  });

  it('normalises weights that do not sum to one and lets the last arm absorb drift', () => {
    const arms = [
      { id: CONTROL, allocation: 1 / 3 },
      { id: VARIANT, allocation: 1 / 3 },
      { id: THIRD, allocation: 1 / 3 },
    ];
    const counts: Record<string, number> = { [CONTROL]: 0, [VARIANT]: 0, [THIRD]: 0 };
    for (const visitorId of visitors(9_000)) {
      counts[assignArm({ visitorId, experimentId: EXPERIMENT_ID, salt: SALT, arms }).armId] += 1;
    }
    expect((counts[CONTROL] as number) + (counts[VARIANT] as number) + (counts[THIRD] as number)).toBe(9_000);
    expect((counts[THIRD] as number) / 9_000).toBeCloseTo(1 / 3, 1);

    // A bucket sitting exactly on the (drifting) upper edge still lands somewhere.
    const unnormalised = [
      { id: CONTROL, allocation: 3 },
      { id: VARIANT, allocation: 1 },
    ];
    const shares = allocationShares(unnormalised);
    expect(shares[CONTROL]).toBeCloseTo(0.75, 10);
    expect(shares[VARIANT]).toBeCloseTo(0.25, 10);
  });

  it('never selects an arm with zero allocation', () => {
    const arms = [
      { id: CONTROL, allocation: 1 },
      { id: VARIANT, allocation: 0 },
    ];
    for (const visitorId of visitors(2_000)) {
      expect(assignArm({ visitorId, experimentId: EXPERIMENT_ID, salt: SALT, arms }).armId).toBe(
        CONTROL,
      );
    }
  });

  it('re-buckets only when the salt changes', () => {
    const visitorId = randomUUID();
    const a = bucketFor(visitorId, SALT);
    expect(bucketFor(visitorId, SALT)).toBe(a);
    expect(bucketFor(visitorId, `${SALT}-v2`)).not.toBe(a);
  });

  it('refuses an unusable configuration instead of silently defaulting', () => {
    expect(() =>
      assignArm({ visitorId: '', experimentId: EXPERIMENT_ID, salt: SALT, arms: EVEN_ARMS }),
    ).toThrow();
    expect(() =>
      assignArm({ visitorId: randomUUID(), experimentId: EXPERIMENT_ID, salt: 'short', arms: EVEN_ARMS }),
    ).toThrow();
    expect(() =>
      assignArm({
        visitorId: randomUUID(),
        experimentId: EXPERIMENT_ID,
        salt: SALT,
        arms: [{ id: CONTROL, allocation: 0 }],
      }),
    ).toThrow();
  });
});

describe('isAllocationChangeSafe', () => {
  const changed = [
    { id: CONTROL, allocation: 0.8 },
    { id: VARIANT, allocation: 0.2 },
  ];

  it('refuses an allocation change while the experiment is RUNNING', () => {
    const check = isAllocationChangeSafe('RUNNING', EVEN_ARMS, changed);
    expect(check.safe).toBe(false);
    expect(check.changed).toBe(true);
    expect(check.reason).toBe('EXPERIMENT_LOCKED');
    expect(check.reasonDe).toContain('laufenden Experiments');
  });

  it('refuses adding or removing an arm while RUNNING', () => {
    const check = isAllocationChangeSafe('RUNNING', EVEN_ARMS, [
      ...EVEN_ARMS,
      { id: THIRD, allocation: 0.2 },
    ]);
    expect(check.safe).toBe(false);
    expect(check.reason).toBe('ARM_SET_CHANGED');
  });

  it('allows a no-op save while RUNNING', () => {
    const check = isAllocationChangeSafe('RUNNING', EVEN_ARMS, [...EVEN_ARMS]);
    expect(check.safe).toBe(true);
    expect(check.changed).toBe(false);
    expect(check.reason).toBe('NO_CHANGE');
  });

  it('allows a change while DRAFT or READY', () => {
    expect(isAllocationChangeSafe('DRAFT', EVEN_ARMS, changed).safe).toBe(true);
    expect(isAllocationChangeSafe('READY', EVEN_ARMS, changed).safe).toBe(true);
  });

  it('refuses a change on a paused or concluded experiment as well', () => {
    expect(isAllocationChangeSafe('PAUSED', EVEN_ARMS, changed).safe).toBe(false);
    expect(isAllocationChangeSafe('CONCLUDED', EVEN_ARMS, changed).safe).toBe(false);
  });

  it('rejects an allocation that adds up to nothing', () => {
    const check = isAllocationChangeSafe('DRAFT', EVEN_ARMS, [
      { id: CONTROL, allocation: 0 },
      { id: VARIANT, allocation: 0 },
    ]);
    expect(check.safe).toBe(false);
    expect(check.reason).toBe('INVALID_ALLOCATION');
  });
});
