import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  POTENZIALANALYSE_FORM_SPEC,
  getField,
  type FieldValidationError,
  type FormField,
} from '@am/funnel-schema';
import { FormFieldControl } from './form-field';
import { resolveFormTargets } from '@/server/spec-targets';
import { fieldDomId, fieldErrorDomId, fieldHelpDomId } from '@/lib/dom-ids';

/**
 * How a choice field is wired to assistive technology.
 *
 * A radio or checkbox group is the one control on this form that is built from
 * several inputs plus a caption, and the caption is where the wiring goes wrong
 * invisibly: nothing about the rendered page looks different when the question
 * text has been welded onto the first option, and nothing looks different when
 * the error message is attached to a `<fieldset>` no one can focus.
 */

const SPEC = POTENZIALANALYSE_FORM_SPEC;
const TARGETS = resolveFormTargets(SPEC, ['example.com']);

const REQUIRED_ERROR_DE = 'Bitte füllen Sie dieses Feld aus.';

function specField(fieldId: string): FormField {
  const field = getField(SPEC, fieldId);
  if (!field) throw new Error(`Kein Feld „${fieldId}" in der Fixture.`);
  return field;
}

/** The fixture form has no BOOLEAN question, and the group markup is shared. */
const BOOLEAN_FIELD: FormField = {
  fieldId: 'entscheider',
  type: 'BOOLEAN',
  label: 'Entscheiden Sie über das Werbebudget?',
  helpText: null,
  placeholder: null,
  required: true,
  piiClass: 'QUALIFICATION',
  qualificationClass: 'SCORING',
  normalization: 'NONE',
  maxLength: 5,
  hubspotProperty: null,
  visibleWhen: null,
  trueLabel: 'Ja, ich entscheide allein',
  falseLabel: 'Nein, wir entscheiden gemeinsam',
};

interface ChoiceCase {
  name: string;
  field: FormField;
  role: 'radio' | 'checkbox';
  /** The option labels, in render order. */
  optionLabels: string[];
}

const CHOICE_CASES: ChoiceCase[] = [
  {
    name: 'SINGLE_SELECT',
    field: specField('rolle'),
    role: 'radio',
    optionLabels: ['Geschäftsführung oder Inhaber:in', 'Marketing', 'Vertrieb', 'Andere Rolle'],
  },
  {
    name: 'MULTI_SELECT',
    field: specField('anfragequellen'),
    role: 'checkbox',
    optionLabels: [
      'Empfehlungen und Mundpropaganda',
      'Bestandskunden',
      'Google-Suche',
      'Social Media',
    ],
  },
  {
    name: 'BOOLEAN',
    field: BOOLEAN_FIELD,
    role: 'radio',
    optionLabels: ['Ja, ich entscheide allein', 'Nein, wir entscheiden gemeinsam'],
  },
];

function renderField(field: FormField, error: FieldValidationError | null = null) {
  const onChange = vi.fn();
  const result = render(
    <FormFieldControl
      spec={SPEC}
      field={field}
      value={undefined}
      error={error}
      onChange={onChange}
      onBlur={() => {}}
      privacyTarget={TARGETS.privacy}
    />,
  );
  return { ...result, onChange };
}

describe('a choice option is named by its own label', () => {
  it.each(CHOICE_CASES)(
    'gives every $name option exactly its own label as accessible name',
    ({ field, role, optionLabels }) => {
      renderField(field);

      const controls = screen.getAllByRole(role);
      expect(controls).toHaveLength(optionLabels.length);

      optionLabels.forEach((label, index) => {
        /* The question belongs to the group, not to one option. When the
           field-level caption borrowed the first option's id, that option
           announced as "<question> <option>" while its siblings announced as
           "<option>" — so the visitor heard the question repeated as part of a
           single answer and never as the question itself. */
        expect(controls[index]).toHaveAccessibleName(label);
        expect(controls[index]).not.toHaveAccessibleName(
          new RegExp(field.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        );
      });
    },
  );

  it.each(CHOICE_CASES)('never points the $name caption at one of its options', ({ field }) => {
    const { container } = renderField(field);

    const caption = container.querySelector<HTMLLabelElement>(
      `label[for="${fieldDomId(field.fieldId)}"]`,
    );
    expect(caption).not.toBeNull();
    /* `HTMLLabelElement.control` resolves `for` against the labelable elements
       only. A caption that names the group resolves to nothing; a caption that
       has captured an option resolves to that option's input. */
    expect(caption?.control ?? null).toBeNull();
  });
});

describe('the question text is not an answer', () => {
  it.each(CHOICE_CASES)('leaves a $name field unanswered when its caption is clicked', async ({
    field,
    role,
  }) => {
    const user = userEvent.setup();
    const { container, onChange } = renderField(field);

    const caption = container.querySelector<HTMLLabelElement>(
      `label[for="${fieldDomId(field.fieldId)}"]`,
    );
    expect(caption).not.toBeNull();

    await user.click(caption!);

    /* A visitor who reads the question and taps it has answered nothing. While
       the caption carried the first option's id, that tap silently selected the
       first answer — and on a scored form that answer reaches the lead. */
    expect(onChange).not.toHaveBeenCalled();
    for (const control of screen.getAllByRole(role)) {
      expect(control).not.toBeChecked();
    }
  });
});

describe('an invalid choice group describes the control, not the box around it', () => {
  const error: FieldValidationError = {
    fieldId: 'rolle',
    code: 'REQUIRED',
    messageDe: REQUIRED_ERROR_DE,
  };

  it('puts the error and the help text on every option of the group', () => {
    const field = specField('rolle');
    renderField(field, error);

    for (const control of screen.getAllByRole('radio')) {
      /* Focus after a failed step lands on an input, never on the `<fieldset>`.
         An `aria-describedby` that sits on the fieldset therefore leaves the
         focused control undescribed: the visitor hears the option and no reason
         why the step refused to advance. */
      const described = (control.getAttribute('aria-describedby') ?? '').split(/\s+/);
      expect(described).toContain(fieldErrorDomId('rolle'));
      expect(described).toContain(fieldHelpDomId('rolle'));
      expect(control).toHaveAccessibleDescription(new RegExp(REQUIRED_ERROR_DE));
      expect(control).toHaveAttribute('aria-invalid', 'true');
    }
  });

  it('keeps a text input wired the same way', () => {
    const field = specField('plz');
    renderField(field, { ...error, fieldId: 'plz' });

    const control = screen.getByLabelText(/Postleitzahl/);
    expect(control).toHaveAccessibleDescription(new RegExp(REQUIRED_ERROR_DE));
    expect(control).toHaveAttribute('aria-invalid', 'true');
  });
});
