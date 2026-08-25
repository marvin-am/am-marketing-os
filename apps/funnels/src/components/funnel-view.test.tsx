import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type FunnelKind } from '@am/domain';
import {
  HYBRID_FUNNEL_SPEC,
  LANDING_PAGE_SPEC,
  POTENZIALANALYSE_FORM_SPEC,
  type FunnelSpec,
} from '@am/funnel-schema';
import type { TrackerContext } from '@am/tracking/beacon';
import { FunnelView } from './funnel-view';
import { resolveFormTargets } from '@/server/spec-targets';
import type { FunnelVersionRecord } from '@/server/ports';

/**
 * The document outline of a served funnel.
 *
 * One page has exactly one first-level heading. It is the assertion that keeps
 * a screen-reader user's "jump to the top heading" landing on what the page is
 * about, and it is trivially broken by composition: the form runtime is correct
 * on its own and the landing-page renderer is correct on its own, and putting
 * one inside the other produces two `h1`s that no visual check reveals.
 */

const TRACKER_CONTEXT: TrackerContext = {
  visitor_id: 'c1c2c3c4-0000-4000-8000-000000000001',
  session_id: 'c1c2c3c4-0000-4000-8000-000000000002',
};

const FORM_TARGETS = resolveFormTargets(POTENZIALANALYSE_FORM_SPEC, ['example.com']);

function versionOf(kind: FunnelKind, spec: FunnelSpec): FunnelVersionRecord {
  return {
    funnelId: 'c1c2c3c4-0000-4000-8000-000000000003',
    funnelVersionId: 'c1c2c3c4-0000-4000-8000-000000000004',
    slug: 'test-funnel',
    kind,
    state: 'PUBLISHED',
    publishedAt: '2026-01-15T09:00:00.000Z',
    spec,
    formVersionId: null,
    experiment: null,
  };
}

function renderFunnel(kind: FunnelKind, spec: FunnelSpec, withForm: boolean) {
  return render(
    <FunnelView
      version={versionOf(kind, spec)}
      formSpec={withForm ? POTENZIALANALYSE_FORM_SPEC : null}
      formTargets={withForm ? FORM_TARGETS : null}
      formInstanceId={withForm ? 'c1c2c3c4-0000-4000-8000-000000000005' : null}
      trackerContext={TRACKER_CONTEXT}
      experiment={null}
      redirectAllowlist={['example.com']}
    />,
  );
}

interface FunnelCase {
  name: string;
  kind: FunnelKind;
  spec: FunnelSpec;
  withForm: boolean;
}

/**
 * Every kind the store can serve, including the landing page that embeds a
 * form: `prepareFunnel` resolves one for a `LANDING_PAGE` carrying an
 * `EMBEDDED_CONTACT` block, so that combination is a served page too.
 */
const FUNNEL_CASES: FunnelCase[] = [
  {
    name: 'MULTI_STEP_FORM',
    kind: 'MULTI_STEP_FORM',
    spec: POTENZIALANALYSE_FORM_SPEC,
    withForm: true,
  },
  { name: 'LANDING_PAGE', kind: 'LANDING_PAGE', spec: LANDING_PAGE_SPEC, withForm: false },
  {
    name: 'LANDING_PAGE mit eingebettetem Formular',
    kind: 'LANDING_PAGE',
    spec: LANDING_PAGE_SPEC,
    withForm: true,
  },
  { name: 'HYBRID', kind: 'HYBRID', spec: HYBRID_FUNNEL_SPEC, withForm: true },
];

beforeEach(() => {
  window.sessionStorage.clear();
  /* The tracker would otherwise try a relative-URL fetch from jsdom. */
  Object.defineProperty(window.navigator, 'sendBeacon', {
    configurable: true,
    writable: true,
    value: vi.fn(() => true),
  });
});

describe('one page, one h1', () => {
  it.each(FUNNEL_CASES)('renders exactly one h1 for $name', ({ kind, spec, withForm }) => {
    renderFunnel(kind, spec, withForm);

    /* A hybrid page ships the hero *and* the form's step heading. Both were
       `h1`, so the page announced two competing titles and the step heading —
       which changes on every answer — competed with the offer for the role of
       "what this page is". */
    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings.map((heading) => heading.textContent)).toHaveLength(1);
  });

  it('keeps the step heading focusable so a new step is announced', () => {
    renderFunnel('HYBRID', HYBRID_FUNNEL_SPEC, true);

    /* Demoting the heading must not cost the step its focus target: the runtime
       moves focus here on a step change, which is the only thing that tells a
       screen-reader user the question changed. */
    const stepHeading = screen.getByRole('heading', {
      name: POTENZIALANALYSE_FORM_SPEC.steps[0]!.title,
    });
    expect(stepHeading.tabIndex).toBe(-1);
  });

  it('still has one h1 once the hybrid form reaches a terminal state', async () => {
    const user = userEvent.setup();
    renderFunnel('HYBRID', HYBRID_FUNNEL_SPEC, true);

    /* The disqualifying walk: a visitor whose budget rules them out never
       reaches the contact step, and the result panel replaces the form while the
       hero stays on the page. */
    const walk: { label: string; role: 'radio' | 'checkbox' }[] = [
      { label: 'Andere Rolle', role: 'radio' },
      { label: 'Social Media', role: 'checkbox' },
      { label: 'Praktisch keine', role: 'radio' },
      { label: 'Unter 500 €', role: 'radio' },
    ];

    for (const answer of walk) {
      await user.click(screen.getByRole(answer.role, { name: answer.label }));
      await user.click(screen.getByRole('button', { name: 'Weiter' }));
    }

    expect(
      await screen.findByRole('heading', { name: 'Wir sind aktuell nicht die richtige Wahl' }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });
});
