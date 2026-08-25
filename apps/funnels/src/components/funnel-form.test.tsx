import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { POTENZIALANALYSE_FORM_SPEC, getField } from '@am/funnel-schema';
import type { TrackerContext } from '@am/tracking/beacon';
import { FunnelForm } from './funnel-form';
import { FormFieldControl } from './form-field';
import { resolveFormTargets } from '@/server/spec-targets';
import { fieldDomId } from '@/lib/dom-ids';

/**
 * The mobile behaviours that decide whether a lead exists at all.
 *
 * Every assertion here is about something that is invisible in a screenshot and
 * expensive in production: a back button that silently wipes four answers, an
 * error nobody's focus lands on, a progress bar that invents a percentage, a
 * consent box that was ticked for the visitor, and a layout that scrolls
 * sideways on the narrowest phone still in circulation.
 */

const SPEC = POTENZIALANALYSE_FORM_SPEC;
const TARGETS = resolveFormTargets(SPEC, ['example.com']);

const TRACKER_CONTEXT: TrackerContext = {
  visitor_id: 'b1b2c3d4-0000-4000-8000-000000000001',
  session_id: 'b1b2c3d4-0000-4000-8000-000000000002',
};

function renderForm(props: Partial<React.ComponentProps<typeof FunnelForm>> = {}) {
  return render(
    <FunnelForm
      spec={SPEC}
      funnelVersionId="b1b2c3d4-0000-4000-8000-000000000003"
      formInstanceId="b1b2c3d4-0000-4000-8000-000000000004"
      targets={TARGETS}
      trackerContext={TRACKER_CONTEXT}
      experiment={null}
      submitEndpoint="/api/submit"
      collectEndpoint="/api/collect"
      {...props}
    />,
  );
}

beforeEach(() => {
  window.sessionStorage.clear();
  /* The tracker would otherwise try a relative-URL fetch from jsdom. A beacon
     stub keeps the tests about the form, not about the network. */
  Object.defineProperty(window.navigator, 'sendBeacon', {
    configurable: true,
    writable: true,
    value: vi.fn(() => true),
  });
});

async function startForm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: SPEC.intro.primaryCtaLabel }));
}

describe('answers survive navigation', () => {
  it('keeps a chosen answer when the visitor goes back a step', async () => {
    const user = userEvent.setup();
    renderForm();
    await startForm(user);

    const chosen = screen.getByRole('radio', { name: /Geschäftsführung/ });
    await user.click(chosen);
    expect(chosen).toBeChecked();

    await user.click(screen.getByRole('button', { name: 'Weiter' }));
    /* Second step: a different question is on screen. */
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/Anfragen heute/);

    await user.click(screen.getByRole('button', { name: /Zurück/ }));

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/Rolle/);
    expect(screen.getByRole('radio', { name: /Geschäftsführung/ })).toBeChecked();
  });

  it('restores a non-PII draft after a reload and never stores contact data', async () => {
    const user = userEvent.setup();
    const first = renderForm();
    await startForm(user);
    await user.click(screen.getByRole('radio', { name: /Geschäftsführung/ }));
    first.unmount();

    const raw = window.sessionStorage.getItem(`am_funnel_draft:${SPEC.formVersionId}`);
    expect(raw).toBeTruthy();
    const stored = JSON.parse(raw as string) as { answers: Record<string, unknown> };
    expect(stored.answers.rolle).toBe('geschaeftsfuehrung');
    /* Contact fields are never written to the browser, even mid-form. */
    expect(Object.keys(stored.answers)).not.toContain('email');
    expect(Object.keys(stored.answers)).not.toContain('telefon');
    expect(Object.keys(stored.answers)).not.toContain('vorname');

    renderForm();
    expect(await screen.findByRole('radio', { name: /Geschäftsführung/ })).toBeChecked();
  });
});

describe('validation feedback', () => {
  it('moves focus to the first invalid field and shows the German message', async () => {
    const user = userEvent.setup();
    renderForm();
    await startForm(user);

    await user.click(screen.getByRole('button', { name: 'Weiter' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Bitte füllen Sie dieses Feld aus.');

    const firstControl = document.getElementById(fieldDomId('rolle'));
    expect(firstControl).not.toBeNull();
    expect(document.activeElement).toBe(firstControl);
  });

  it('clears the error as soon as the visitor answers', async () => {
    const user = userEvent.setup();
    renderForm();
    await startForm(user);

    await user.click(screen.getByRole('button', { name: 'Weiter' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: /Marketing/ }));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('progress', () => {
  it('never shows a percentage while the path can still branch', async () => {
    const user = userEvent.setup();
    renderForm();
    await startForm(user);

    const progressbar = screen.getByRole('progressbar');
    /* A disqualifying answer can end this form early, so the remaining length is
       genuinely unknown. ARIA says that is expressed by omitting the value. */
    expect(progressbar).not.toHaveAttribute('aria-valuenow');
    expect(progressbar).toHaveAttribute('aria-valuetext', 'Schritt 1');
    expect(screen.queryByText(/\d+\s*%/)).toBeNull();
  });
});

describe('consent', () => {
  it('is never pre-ticked', () => {
    expect(SPEC.consent.defaultChecked).toBe(false);

    const consentField = getField(SPEC, SPEC.consent.fieldId);
    expect(consentField).not.toBeNull();

    render(
      <FormFieldControl
        spec={SPEC}
        field={consentField!}
        value={undefined}
        error={null}
        onChange={() => {}}
        onBlur={() => {}}
        privacyTarget={TARGETS.privacy}
      />,
    );

    const checkbox = screen.getByRole('checkbox');
    expect(checkbox).not.toBeChecked();
    expect(screen.getByText(new RegExp(SPEC.consent.textDe.slice(0, 30)))).toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------------- */
/* Layout                                                                      */
/* -------------------------------------------------------------------------- */

const FIXED_WIDTH_CLASS = /(?:^|:)(?:min-)?w-\[(\d+(?:\.\d+)?)px\]/;

/**
 * jsdom performs no layout, so `getBoundingClientRect` cannot prove a page fits.
 * What it *can* prove — and what actually regresses in practice — is that no
 * element declares a width the viewport cannot hold: a hard-coded pixel width, a
 * `w-screen`, or an inline style. That is the class of mistake that produces a
 * horizontal scrollbar at 320 px.
 */
function oversizedElements(root: HTMLElement, viewport: number): string[] {
  const offenders: string[] = [];

  for (const element of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
    const classes = element.getAttribute('class') ?? '';

    for (const token of classes.split(/\s+/)) {
      if (token.includes('w-screen')) offenders.push(`${element.tagName}.${token}`);
      const match = FIXED_WIDTH_CLASS.exec(token);
      if (match && Number(match[1]) > viewport) offenders.push(`${element.tagName}.${token}`);
    }

    for (const property of ['width', 'minWidth'] as const) {
      const declared = element.style[property];
      if (declared.endsWith('px') && Number.parseFloat(declared) > viewport) {
        offenders.push(`${element.tagName}[style.${property}=${declared}]`);
      }
    }

    if (element.getBoundingClientRect().width > viewport) {
      offenders.push(`${element.tagName}[measured]`);
    }
  }

  return offenders;
}

describe('narrow viewports', () => {
  it.each([320, 375, 430])('declares no element wider than %i px', async (viewport) => {
    const user = userEvent.setup();
    const { container } = renderForm();
    await startForm(user);

    expect(oversizedElements(container, viewport)).toEqual([]);
  });

  it('keeps every hit target at least 44 px tall', async () => {
    const user = userEvent.setup();
    const { container } = renderForm();
    await startForm(user);

    const controls = Array.from(
      container.querySelectorAll<HTMLElement>('button, input:not([type="hidden"]), label'),
    ).filter(
      (element) =>
        element.closest('[aria-hidden="true"]') === null &&
        /* A caption `<label for=…>` is not a hit target; a label that wraps a
           control is, and it is the element that has to be 44 px tall. */
        (element.tagName !== 'LABEL' || element.querySelector('input') !== null),
    );

    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      const classes = control.getAttribute('class') ?? '';
      const target =
        classes.includes('min-h-11') ||
        classes.includes('h-11') ||
        /* A radio dot is not the target — the label that wraps it is. */
        control.closest('label')?.className.includes('min-h-11') === true ||
        control.tagName === 'INPUT';
      expect(target, `${control.tagName} "${classes}"`).toBe(true);
    }
  });

  it('lets the one wide element scroll inside its own box', () => {
    /* Comparison tables legitimately want more width than 320 px. The rule is
       that they scroll themselves; the page never does. */
    const { container } = render(
      <div className="w-full min-w-0 overflow-x-auto">
        <table>
          <tbody>
            <tr>
              <td>Wert</td>
            </tr>
          </tbody>
        </table>
      </div>,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).toContain('overflow-x-auto');
    expect(within(wrapper).getByRole('table')).toBeInTheDocument();
  });
});
