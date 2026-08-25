import { isDomainError } from '@am/domain';
import { describe, expect, it } from 'vitest';
import { fixtureContextBundle } from '../provider/fixture-bundle';
import { assertContextFree, buildContext, findContextPiiViolations } from './context';

describe('buildContext', () => {
  const bundle = fixtureContextBundle();
  const context = buildContext({
    bundle,
    briefDe: 'Neue Kampagne für das Q3-Budget, Fokus auf Elektro- und Sanitärbetriebe.',
  });

  it('renders the approved knowledge into a single German block', () => {
    expect(context.brandName).toBe('A&M Beratung');
    expect(context.contextBlock).toContain('### Marke');
    expect(context.contextBlock).toContain('### Zielgruppensegmente');
    expect(context.contextBlock).toContain('### Freigegebene Fallstudien');
    expect(context.briefDe).toContain('Q3-Budget');
  });

  it('carries guardrails separately so every prompt can restate them', () => {
    expect(context.guardrailsDe).toHaveLength(3);
    expect(context.guardrailsDe[0]).toContain('[BLOCK]');
    expect(context.guardrailsDe[0]).toContain('günstig');
  });

  it('excludes unapproved evidence', () => {
    expect(context.contextBlock).toContain('Elektrotechnik-Betrieb aus dem Sauerland');
    expect(context.contextBlock).not.toContain('Freigabe steht noch aus');
  });

  it('drops testimonial author names but keeps role and company', () => {
    const testimonial = bundle.testimonials[0]!;
    expect(context.contextBlock).toContain(testimonial.quote);
    expect(context.contextBlock).toContain('Inhaber, Elektrotechnik-Betrieb Sauerland');
  });

  it('is content addressed, so an unchanged context reuses its hash', () => {
    const again = buildContext({
      bundle: fixtureContextBundle(),
      briefDe: 'Neue Kampagne für das Q3-Budget, Fokus auf Elektro- und Sanitärbetriebe.',
    });
    expect(again.contextHash).toBe(context.contextHash);

    const different = buildContext({ bundle, briefDe: 'Anderer Auftrag.' });
    expect(different.contextHash).not.toBe(context.contextHash);
  });
});

describe('PII guard', () => {
  const bundle = fixtureContextBundle();

  it('throws when a brief carries an e-mail address', () => {
    expect.assertions(3);
    try {
      buildContext({
        bundle,
        briefDe: 'Bitte den Lead von marvin@am-beratung.de mit aufnehmen.',
      });
    } catch (error) {
      expect(isDomainError(error)).toBe(true);
      if (isDomainError(error)) {
        expect(error.code).toBe('VALIDATION_FAILED');
        expect(JSON.stringify(error.details)).toContain('E-Mail-Muster');
      }
    }
  });

  it('throws when a phone number reaches the context', () => {
    expect(() =>
      buildContext({
        bundle,
        briefDe: 'Rückfragen an +49 231 5566778 richten.',
      }),
    ).toThrow(/personenbezogene Daten/);
  });

  it('throws when a lead or CRM key is present anywhere in the bundle', () => {
    const contaminated = {
      ...bundle,
      services: [
        {
          id: '33333333-3333-4333-8333-333333333333',
          name: 'Ablaufberatung',
          description: 'Aufbau eines eigenen Bewerbungswegs.',
          hubspot_contact_id: '4711',
        },
      ],
    };
    expect(() => buildContext({ bundle: contaminated as never, briefDe: 'Auftrag.' })).toThrow(
      /personenbezogene Daten/,
    );
  });

  it('names the offending path so the console can point at the field', () => {
    const violations = findContextPiiViolations({
      brief: { text: 'Kontakt: info@example.com' },
      answers: ['x'],
    });
    expect(violations).toEqual([
      { path: '$.brief.text', reasonDe: 'E-Mail-Muster im Text' },
      { path: '$.answers', reasonDe: 'Schlüssel gehört zu Lead- oder CRM-Daten' },
    ]);
  });

  it('does not flag legitimate business fields called "name"', () => {
    expect(
      findContextPiiViolations({ name: 'A&M Beratung', geo: 'Deutschland', roles: ['Inhaber'] }),
    ).toEqual([]);
    expect(() => assertContextFree({ name: 'A&M Beratung' })).not.toThrow();
  });

  it('does not flag ordinary numbers such as company sizes or dates', () => {
    expect(
      findContextPiiViolations({
        size: '10 bis 50 Mitarbeitende',
        approvedAt: '2026-02-11T09:00:00+00:00',
      }),
    ).toEqual([]);
  });
});
