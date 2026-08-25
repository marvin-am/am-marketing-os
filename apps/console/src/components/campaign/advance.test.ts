import { describe, expect, it } from 'vitest';
import { CAMPAIGN_STATES, CAMPAIGN_TRANSITIONS, canTransition, type CampaignState } from '@am/domain';
import { CAMPAIGN_TABS, type CampaignTab } from '@/server/campaign-port';
import { advanceOptionFor, advanceTabFor, isForwardTransition, rollbackOptionFor } from './advance';

/**
 * The Campaign Room offers exactly one thing as „the next step". These are
 * properties over the whole state set rather than examples, because the
 * transition graph legitimately carries back edges and a back edge added to it
 * later must not be able to become the forward affordance again.
 */

const EVERY_PAIR: readonly (readonly [CampaignTab, CampaignState])[] = CAMPAIGN_TABS.flatMap(
  (tab) => CAMPAIGN_STATES.map((state) => [tab, state] as const),
);

describe('advanceOptionFor', () => {
  /**
   * The defect this pins down: the first *legal* candidate for a tab can be a
   * rollback, so the primary button walked the campaign backwards while calling
   * itself the next step.
   */
  it('never offers a step that moves the campaign back through the lifecycle', () => {
    const backwards = EVERY_PAIR.flatMap(([tab, state]) => {
      const option = advanceOptionFor(tab, state);
      return option !== null && !isForwardTransition(state, option.to)
        ? [`${tab} @ ${state} → ${option.to}`]
        : [];
    });
    expect(backwards).toEqual([]);
  });

  it('only ever offers a transition the domain allows', () => {
    for (const [tab, state] of EVERY_PAIR) {
      const option = advanceOptionFor(tab, state);
      if (option === null) continue;
      expect(canTransition(state, option.to)).toBe(true);
    }
  });

  /**
   * Guidance can only name the place the operator has to go while at most one
   * place exists. Two tabs offering a forward step out of the same state would
   * make „the next step" a choice, not an instruction.
   */
  it('leaves at most one tab holding the forward step for a state', () => {
    for (const state of CAMPAIGN_STATES) {
      const offering = CAMPAIGN_TABS.filter((tab) => advanceOptionFor(tab, state) !== null);
      expect(offering.length).toBeLessThanOrEqual(1);
      expect(advanceTabFor(state)?.tab ?? null).toBe(offering[0] ?? null);
    }
  });

  it('sends a campaign with a created Meta draft live instead of back to the draft gate', () => {
    expect(advanceOptionFor('launch-qa', 'META_DRAFT_CREATED')).toEqual({
      to: 'LIVE',
      labelDe: 'Kampagne live schalten',
      publishing: true,
    });
  });

  it('offers the launch sequence in order, one step at a time', () => {
    expect(advanceTabFor('STRATEGY_REVIEW')?.option.to).toBe('STRATEGY_APPROVED');
    expect(advanceTabFor('STRATEGY_APPROVED')?.option.to).toBe('ASSET_GENERATION');
    expect(advanceTabFor('ASSET_GENERATION')?.option.to).toBe('ASSET_REVIEW');
    expect(advanceTabFor('ASSET_REVIEW')).toEqual({
      tab: 'creatives',
      option: { to: 'TEST_PLAN_REVIEW', labelDe: 'Weiter zum Testplan', publishing: false },
    });
    expect(advanceTabFor('TEST_PLAN_REVIEW')?.tab).toBe('testplan');
    expect(advanceTabFor('READY_FOR_LAUNCH_QA')?.option.to).toBe('READY_FOR_META_DRAFT');
    expect(advanceTabFor('READY_FOR_META_DRAFT')?.option.to).toBe('META_DRAFT_CREATED');
  });

  it('has no forward step for a delivering or finished campaign', () => {
    for (const state of ['LIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED'] as const) {
      expect(advanceTabFor(state)).toBeNull();
    }
  });
});

describe('isForwardTransition', () => {
  it('agrees with the lifecycle order the domain declares', () => {
    for (const from of CAMPAIGN_STATES) {
      for (const to of CAMPAIGN_TRANSITIONS[from]) {
        expect(isForwardTransition(from, to)).toBe(
          CAMPAIGN_STATES.indexOf(to) > CAMPAIGN_STATES.indexOf(from),
        );
      }
    }
  });
});

describe('rollbackOptionFor', () => {
  it('only ever offers a legal transition backwards', () => {
    for (const [tab, state] of EVERY_PAIR) {
      const rollback = rollbackOptionFor(tab, state);
      if (rollback === null) continue;
      expect(canTransition(state, rollback.to)).toBe(true);
      expect(isForwardTransition(state, rollback.to)).toBe(false);
    }
  });

  /**
   * The rollback and the next step are two different operations. If they could
   * ever name the same target the distinction would be cosmetic.
   */
  it('never coincides with the step offered as the next one', () => {
    for (const [tab, state] of EVERY_PAIR) {
      const rollback = rollbackOptionFor(tab, state);
      const advance = advanceOptionFor(tab, state);
      if (rollback === null || advance === null) continue;
      expect(rollback.to).not.toBe(advance.to);
    }
  });

  it('names the target state in German and says plainly that it is not progress', () => {
    const rollback = rollbackOptionFor('launch-qa', 'META_DRAFT_CREATED');
    expect(rollback?.to).toBe('READY_FOR_META_DRAFT');
    expect(rollback?.labelDe).toBe('Zurück auf „Bereit für Meta-Entwurf"');
    expect(rollback?.confirmDe).toContain('kein Fortschritt im Kampagnenablauf');
  });

  it('is offered only on the tab that performed the step being taken back', () => {
    expect(rollbackOptionFor('strategie', 'META_DRAFT_CREATED')).toBeNull();
    expect(rollbackOptionFor('creatives', 'META_DRAFT_CREATED')).toBeNull();
    expect(rollbackOptionFor('testplan', 'META_DRAFT_CREATED')).toBeNull();
  });

  it('offers no way to un-launch a delivering campaign', () => {
    for (const tab of CAMPAIGN_TABS) {
      expect(rollbackOptionFor(tab, 'LIVE')).toBeNull();
    }
  });
});
