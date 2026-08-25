import { DomainError, type AiContextBundle } from '@am/domain';
import { hashUnknown } from '../hash';
import type { PromptContext } from '../prompts/inputs';

/**
 * Context isolation.
 *
 * `buildContext()` is the only function in this package that turns stored data
 * into something a model can read. Every prompt takes a `PromptContext` and
 * nothing wider, so there is no code path from a submission, a lead or a
 * HubSpot record into a prompt — the type system makes the wrong thing
 * unrepresentable, and `assertContextFree` catches the case where a person
 * pastes a lead's details into a campaign brief by hand.
 *
 * Two further rules are enforced here rather than trusted to the prompt:
 *
 * - only *approved* evidence, case studies, testimonials and FAQs are rendered;
 * - testimonial author names are dropped. Role and company carry the credibility
 *   a copywriter needs; the personal name is composed deterministically at
 *   render time, so it never has to travel through a model.
 */

const EMAIL_LIKE = /[\w.+-]+@[\w-]+\.[\w-]{2,}/;
const PHONE_LIKE = /(?:\+|\b00)\d[\d\s\-()]{7,}/;

/**
 * Keys that only ever appear on lead, contact or CRM records. Deliberately
 * narrow: a blanket ban on `name` would reject the brand's own name and make
 * the guard useless in practice.
 */
const FORBIDDEN_CONTEXT_KEYS: readonly string[] = [
  'email',
  'e_mail',
  'emailaddress',
  'email_address',
  'mailadresse',
  'phone',
  'phone_number',
  'telefon',
  'telefonnummer',
  'mobile',
  'firstname',
  'first_name',
  'vorname',
  'lastname',
  'last_name',
  'nachname',
  'fullname',
  'full_name',
  'lead',
  'leads',
  'lead_id',
  'leadid',
  'contact',
  'contact_id',
  'contactid',
  'hubspot_contact_id',
  'hubspot_deal_id',
  'submission',
  'submissions',
  'submission_id',
  'answers',
  'antworten',
  'ip',
  'ip_address',
  'user_agent',
  'visitor_id',
  'session_id',
];

export interface ContextPiiViolation {
  path: string;
  reasonDe: string;
}

/** Structural PII scan over the assembled context. */
export function findContextPiiViolations(value: unknown, path = '$'): ContextPiiViolation[] {
  const violations: ContextPiiViolation[] = [];

  const walk = (input: unknown, currentPath: string): void => {
    if (input === null || input === undefined) return;

    if (typeof input === 'string') {
      if (EMAIL_LIKE.test(input)) {
        violations.push({ path: currentPath, reasonDe: 'E-Mail-Muster im Text' });
      } else if (PHONE_LIKE.test(input)) {
        violations.push({ path: currentPath, reasonDe: 'Telefonnummer-Muster im Text' });
      }
      return;
    }

    if (Array.isArray(input)) {
      input.forEach((item, index) => walk(item, `${currentPath}[${index}]`));
      return;
    }

    if (typeof input === 'object') {
      for (const [key, child] of Object.entries(input as Record<string, unknown>)) {
        if (FORBIDDEN_CONTEXT_KEYS.includes(key.toLowerCase())) {
          violations.push({
            path: `${currentPath}.${key}`,
            reasonDe: 'Schlüssel gehört zu Lead- oder CRM-Daten',
          });
          continue;
        }
        walk(child, `${currentPath}.${key}`);
      }
    }
  };

  walk(value, path);
  return violations;
}

/** Throws when anything resembling lead, contact or CRM data is present. */
export function assertContextFree(value: unknown, path = '$'): void {
  const violations = findContextPiiViolations(value, path);
  if (violations.length === 0) return;
  throw new DomainError('VALIDATION_FAILED', {
    messageDe:
      'Der KI-Kontext enthält personenbezogene Daten. Lead- und CRM-Daten dürfen niemals in einen Prompt gelangen.',
    details: { violations },
  });
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

function section(title: string, lines: readonly string[]): string | null {
  const body = lines.filter((line) => line.trim().length > 0);
  if (body.length === 0) return null;
  return `### ${title}\n${body.join('\n')}`;
}

function bullets(items: readonly string[]): string[] {
  return items.map((item) => `- ${item}`);
}

export interface BuildContextInput {
  bundle: AiContextBundle;
  /** The operator's brief for this campaign. */
  briefDe: string;
  /** Extra approved notes to append; still subject to the PII guard. */
  notesDe?: readonly string[];
}

/**
 * Assembles the approved knowledge base into the single German block a prompt
 * may read. Throws `VALIDATION_FAILED` when anything PII-shaped is present.
 */
export function buildContext(input: BuildContextInput): PromptContext {
  const { bundle } = input;

  // Guard the raw inputs before rendering: a violation must name the field it
  // came from, not an offset into a formatted string.
  assertContextFree(bundle, '$.bundle');
  assertContextFree({ briefDe: input.briefDe, notesDe: input.notesDe ?? [] }, '$.brief');

  const approvedEvidence = bundle.evidence.filter((item) => item.approved);
  const approvedCaseStudies = bundle.caseStudies.filter((item) => item.approved && item.usableInAds);
  const approvedTestimonials = bundle.testimonials.filter(
    (item) => item.approved && item.usableInAds,
  );
  const approvedFaqs = bundle.faqs.filter((item) => item.approved);

  const sections: (string | null)[] = [
    section('Marke', [
      `Name: ${bundle.brand.name}`,
      `Positionierung: ${bundle.brand.positioning}`,
      `Tonalität: ${bundle.brand.toneOfVoice}`,
      bundle.brand.preferredTerms.length > 0
        ? `Bevorzugte Begriffe: ${bundle.brand.preferredTerms.join(', ')}`
        : '',
      bundle.brand.avoidTerms.length > 0
        ? `Zu vermeidende Begriffe: ${bundle.brand.avoidTerms.join(', ')}`
        : '',
    ]),
    section(
      'Zielgruppensegmente',
      bundle.audiences.flatMap((audience) => [
        `- ${audience.name}: ${audience.description}`,
        audience.painPoints.length > 0 ? `  Schmerzpunkte: ${audience.painPoints.join('; ')}` : '',
        audience.objections.length > 0 ? `  Einwände: ${audience.objections.join('; ')}` : '',
        audience.buyingTriggers.length > 0
          ? `  Kaufauslöser: ${audience.buyingTriggers.join('; ')}`
          : '',
      ]),
    ),
    section(
      'Leistungen',
      bundle.services.map((service) => `- ${service.name}: ${service.description}`),
    ),
    section('Angebote', bundle.offers.map((offer) => `- ${offer.name}: ${offer.description}`)),
    section(
      'Freigegebene Evidenz (einzige zulässige Belegquelle)',
      approvedEvidence.map(
        (item) =>
          `- [${item.kind}] ${item.statement} (Quelle: ${item.source || 'ohne Quellenangabe'})`,
      ),
    ),
    section(
      'Freigegebene Fallstudien',
      approvedCaseStudies.flatMap((study) => [
        `- ${study.client}${study.industry ? ` (${study.industry})` : ''}`,
        `  Ausgangslage: ${study.challenge}`,
        `  Vorgehen: ${study.approach}`,
        `  Ergebnis: ${study.outcome}`,
      ]),
    ),
    section(
      'Freigegebene Kundenstimmen',
      // Author names are intentionally omitted — see the module comment.
      approvedTestimonials.map(
        (testimonial) =>
          `- „${testimonial.quote}“ — ${testimonial.authorRole ?? 'Position nicht angegeben'}${
            testimonial.company ? `, ${testimonial.company}` : ''
          }`,
      ),
    ),
    section(
      'Freigegebene FAQ',
      approvedFaqs.flatMap((faq) => [`- Frage: ${faq.question}`, `  Antwort: ${faq.answer}`]),
    ),
    section('Weitere freigegebene Hinweise', bullets(input.notesDe ?? [])),
  ];

  const guardrailsDe = bundle.guardrails.map(
    (guardrail) =>
      `[${guardrail.severity}] ${guardrail.kind} — ${guardrail.reasonDe} (Muster: „${guardrail.pattern}“)`,
  );

  const contextBlock = sections.filter((entry): entry is string => entry !== null).join('\n\n');

  // Belt and braces: the rendered block is scanned as well, so a PII value that
  // arrived through an unexpected field still cannot leave this function.
  assertContextFree({ contextBlock, guardrailsDe }, '$.rendered');

  return {
    contextBlock,
    brandName: bundle.brand.name,
    guardrailsDe,
    briefDe: input.briefDe,
    contextHash: hashUnknown({ contextBlock, guardrailsDe, briefDe: input.briefDe }),
  };
}
