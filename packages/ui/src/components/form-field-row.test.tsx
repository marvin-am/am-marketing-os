import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FormFieldRow } from './form-field-row';
import { Input } from './input';

describe('FormFieldRow', () => {
  it('labels the control and wires the help text', () => {
    render(
      <FormFieldRow label="E-Mail" help="Nur geschäftliche Adressen.">
        <Input type="email" />
      </FormFieldRow>,
    );

    const input = screen.getByLabelText('E-Mail');
    const describedBy = input.getAttribute('aria-describedby');

    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)).toHaveTextContent(
      'Nur geschäftliche Adressen.',
    );
    expect(input).not.toHaveAttribute('aria-invalid', 'true');
  });

  it('sets aria-invalid and points aria-describedby at the error message', () => {
    render(
      <FormFieldRow label="E-Mail" error="Bitte geben Sie eine gültige E-Mail-Adresse ein.">
        <Input type="email" />
      </FormFieldRow>,
    );

    const input = screen.getByLabelText('E-Mail');
    expect(input).toHaveAttribute('aria-invalid', 'true');

    const ids = (input.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean);
    expect(ids.length).toBeGreaterThan(0);

    const described = ids
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    expect(described).toContain('Bitte geben Sie eine gültige E-Mail-Adresse ein.');

    const message = screen.getByRole('alert');
    expect(message).toHaveTextContent('Bitte geben Sie eine gültige E-Mail-Adresse ein.');
    expect(ids).toContain(message.id);
  });

  it('describes the control with both the error and the help text', () => {
    render(
      <FormFieldRow label="Budget" help="In Euro pro Tag." error="Pflichtfeld">
        <Input />
      </FormFieldRow>,
    );

    const input = screen.getByLabelText('Budget');
    const described = (input.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' | ');

    expect(described).toContain('Pflichtfeld');
    expect(described).toContain('In Euro pro Tag.');
  });

  it('marks required fields for assistive technology', () => {
    render(
      <FormFieldRow label="Angle" required>
        <Input />
      </FormFieldRow>,
    );

    expect(screen.getByLabelText(/Angle/)).toHaveAttribute('aria-required', 'true');
    expect(screen.getByText('(Pflichtfeld)')).toBeInTheDocument();
  });

  it('supports a render prop for controls that cannot take injected props', () => {
    render(
      <FormFieldRow label="Notiz" error="Zu lang">
        {({ id, describedBy, invalid }) => (
          <textarea id={id} aria-describedby={describedBy} aria-invalid={invalid} />
        )}
      </FormFieldRow>,
    );

    expect(screen.getByLabelText('Notiz')).toHaveAttribute('aria-invalid', 'true');
  });
});
