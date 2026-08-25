import {
  DomainError,
  GENERATION_DEFAULTS,
  OFFER_TYPE_LABELS_DE,
  type ConsentPurpose,
  type OfferType,
  type QualificationClass,
} from '@am/domain';
import {
  anchorLink,
  internalLink,
  DEFAULT_THEME,
  SPEC_SCHEMA_VERSION,
  type BookingMode,
  type BookingSpec,
  type CtaSpec,
  type LinkTarget,
  type MediaRef,
  type SeoSpec,
  type ThemeSpec,
} from './common';
import {
  atom,
  anyOf,
  DEFAULT_MAX_LENGTH,
  DEFAULT_NORMALIZATION,
  type FieldOption,
  type FormField,
  type FormStep,
  type IntroSpec,
  type MultiStepFormSpec,
  type QualificationRule,
  type ResultVariant,
  type RoutingRule,
} from './form-spec';
import {
  type EmbeddedFormRef,
  type HybridFunnelSpec,
  type LandingPageSpec,
  type PageBlock,
  type ProofPoint,
} from './page-spec';

/**
 * Spec generators.
 *
 * `buildDefaultMultiStepForm` produces the mandated default flow — a short
 * intro/offer screen, four to seven angle-related qualification questions
 * (exactly five unless configured otherwise), the postcode, contact data,
 * consent and a terminal thank-you / analysis / booking state — and its output
 * passes `validateFormSpec` with zero errors.
 *
 * The generators never invent an external identifier: a booking link that has
 * not been supplied stays `null`, and every HubSpot mapping slot starts empty.
 */

/* -------------------------------------------------------------------------- */
/* Small builders                                                              */
/* -------------------------------------------------------------------------- */

function cta(
  label: string,
  action: CtaSpec['action'],
  target: LinkTarget | null = null,
  style: CtaSpec['style'] = 'PRIMARY',
): CtaSpec {
  return { label, action, target, style, note: null };
}

/** Brand token overrides; every token not named keeps its default. */
export type ThemeOverrides = Partial<Omit<ThemeSpec, 'colors'>> & {
  colors?: Partial<ThemeSpec['colors']>;
};

function mergeTheme(theme?: ThemeOverrides): ThemeSpec {
  return {
    ...DEFAULT_THEME,
    ...theme,
    colors: { ...DEFAULT_THEME.colors, ...theme?.colors },
  };
}

/* -------------------------------------------------------------------------- */
/* Form input                                                                  */
/* -------------------------------------------------------------------------- */

export interface QuestionOptionDraft {
  id: string;
  label: string;
  helpText?: string | null;
  /** Points this option adds to the qualification score. */
  score?: number;
  /** Selecting this option ends the form in the "not a fit" state. */
  disqualifying?: boolean;
}

export type QuestionFieldType =
  'SINGLE_SELECT' | 'MULTI_SELECT' | 'BOOLEAN' | 'NUMBER' | 'RANGE' | 'SHORT_TEXT' | 'LONG_TEXT';

export interface QuestionDraft {
  key: string;
  label: string;
  helpText?: string | null;
  type?: QuestionFieldType;
  options?: QuestionOptionDraft[];
  required?: boolean;
  qualificationClass?: QualificationClass;
  min?: number;
  max?: number;
  step?: number;
  unit?: string | null;
  minSelected?: number;
  maxSelected?: number;
  trueLabel?: string;
  falseLabel?: string;
}

export interface ConsentDraft {
  fieldId?: string;
  /** Short visible label next to the checkbox; the legal text lives in `textDe`. */
  label?: string;
  consentVersionId: string;
  textDe: string;
  purposes: ConsentPurpose[];
  privacyPolicyUrl: string;
}

export interface BookingDraft {
  mode?: BookingMode;
  /** `null` while no meeting link has been supplied — never invented. */
  href?: string | null;
  label?: string;
  helpText?: string | null;
}

export interface BuildFormInput {
  formId: string;
  formVersionId: string;
  offerId: string;
  angleId: string;
  title: string;
  offerType: OfferType;
  angleName: string;
  offerName?: string;
  effortPromise?: string | null;
  intro?: Partial<IntroSpec>;
  /** Four to seven questions; five by default. */
  questions?: QuestionDraft[];
  consent: ConsentDraft;
  theme?: ThemeOverrides;
  booking?: BookingDraft | null;
  collectPhone?: boolean;
  collectCompany?: boolean;
  resultKind?: 'THANK_YOU' | 'ANALYSIS' | 'BOOKING' | 'LEAD_MAGNET';
  submitEndpointPath?: string;
  privacyPath?: string;
}

/* -------------------------------------------------------------------------- */
/* Default questions                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Five generic-but-real B2B qualification questions used when the caller does
 * not supply its own. The AI pipeline normally replaces these with
 * angle-specific wording; the shape stays identical.
 */
export function defaultQualificationQuestions(angleName: string): QuestionDraft[] {
  return [
    {
      key: 'rolle',
      label: 'Welche Rolle haben Sie im Unternehmen?',
      helpText: 'So können wir die Auswertung auf Ihre Entscheidungssituation zuschneiden.',
      options: [
        { id: 'geschaeftsfuehrung', label: 'Geschäftsführung / Inhaber:in', score: 4 },
        { id: 'marketing', label: 'Marketing', score: 3 },
        { id: 'vertrieb', label: 'Vertrieb', score: 2 },
        { id: 'sonstige', label: 'Andere Rolle', score: 0 },
      ],
    },
    {
      key: 'mitarbeitende',
      label: 'Wie viele Mitarbeitende hat Ihr Unternehmen?',
      options: [
        { id: 'bis_4', label: '1 bis 4', score: 0 },
        { id: 'von_5_bis_19', label: '5 bis 19', score: 2 },
        { id: 'von_20_bis_49', label: '20 bis 49', score: 4 },
        { id: 'ab_50', label: '50 und mehr', score: 4 },
      ],
    },
    {
      key: 'anfragen_pro_monat',
      label: 'Wie viele qualifizierte Anfragen erhalten Sie aktuell pro Monat?',
      helpText: `Bezogen auf ${angleName}.`,
      options: [
        { id: 'keine', label: 'Praktisch keine', score: 1 },
        { id: 'bis_10', label: 'Bis zu 10', score: 3 },
        { id: 'bis_30', label: '11 bis 30', score: 4 },
        { id: 'ueber_30', label: 'Mehr als 30', score: 2 },
      ],
    },
    {
      key: 'werbebudget',
      label: 'Welches monatliche Werbebudget steht Ihnen zur Verfügung?',
      helpText: 'Ohne Agenturhonorar, nur das reine Mediabudget.',
      options: [
        { id: 'unter_1000', label: 'Unter 1.000 €', score: 0, disqualifying: true },
        { id: 'von_1000_bis_2500', label: '1.000 € bis 2.500 €', score: 2 },
        { id: 'von_2500_bis_5000', label: '2.500 € bis 5.000 €', score: 4 },
        { id: 'ueber_5000', label: 'Mehr als 5.000 €', score: 5 },
      ],
    },
    {
      key: 'zeitpunkt',
      label: 'Wann möchten Sie starten?',
      options: [
        { id: 'sofort', label: 'So schnell wie möglich', score: 4 },
        { id: 'in_drei_monaten', label: 'In den nächsten drei Monaten', score: 3 },
        { id: 'spaeter', label: 'Später im Jahr', score: 1 },
        { id: 'unklar', label: 'Noch offen', score: 0 },
      ],
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* Field construction                                                          */
/* -------------------------------------------------------------------------- */

function toOptions(drafts: QuestionOptionDraft[]): FieldOption[] {
  return drafts.map((draft) => ({
    optionId: draft.id,
    label: draft.label,
    helpText: draft.helpText ?? null,
    score: draft.score ?? 0,
  }));
}

function questionField(draft: QuestionDraft): FormField {
  const type = draft.type ?? 'SINGLE_SELECT';
  const base = {
    fieldId: draft.key,
    label: draft.label,
    helpText: draft.helpText ?? null,
    placeholder: null,
    required: draft.required ?? true,
    piiClass: 'QUALIFICATION' as const,
    qualificationClass:
      draft.qualificationClass ??
      ((draft.options ?? []).some((option) => option.disqualifying)
        ? ('DISQUALIFYING' as const)
        : ('SCORING' as const)),
    normalization: DEFAULT_NORMALIZATION[type],
    maxLength: DEFAULT_MAX_LENGTH[type],
    hubspotProperty: null,
    visibleWhen: null,
  };

  switch (type) {
    case 'MULTI_SELECT': {
      const options = toOptions(draft.options ?? []);
      return {
        ...base,
        type: 'MULTI_SELECT',
        options,
        minSelected: draft.minSelected ?? (base.required ? 1 : 0),
        maxSelected: draft.maxSelected ?? Math.max(1, options.length),
      };
    }
    case 'BOOLEAN':
      return {
        ...base,
        type: 'BOOLEAN',
        trueLabel: draft.trueLabel ?? 'Ja',
        falseLabel: draft.falseLabel ?? 'Nein',
      };
    case 'NUMBER':
      return {
        ...base,
        type: 'NUMBER',
        min: draft.min ?? 0,
        max: draft.max ?? 1_000_000,
        step: draft.step ?? 1,
        unit: draft.unit ?? null,
      };
    case 'RANGE':
      return {
        ...base,
        type: 'RANGE',
        min: draft.min ?? 0,
        max: draft.max ?? 100,
        step: draft.step ?? 1,
        unit: draft.unit ?? null,
        minLabel: null,
        maxLabel: null,
      };
    case 'SHORT_TEXT':
      return { ...base, type: 'SHORT_TEXT', minLength: base.required ? 2 : 0 };
    case 'LONG_TEXT':
      return { ...base, type: 'LONG_TEXT', minLength: base.required ? 10 : 0, rows: 4 };
    default:
      return {
        ...base,
        type: 'SINGLE_SELECT',
        options: toOptions(draft.options ?? []),
        display: 'CARDS',
      };
  }
}

function contactFields(input: BuildFormInput): FormField[] {
  const fields: FormField[] = [
    {
      fieldId: 'vorname',
      type: 'FIRST_NAME',
      label: 'Vorname',
      helpText: null,
      placeholder: null,
      required: true,
      piiClass: 'PII',
      qualificationClass: 'NONE',
      normalization: DEFAULT_NORMALIZATION.FIRST_NAME,
      maxLength: DEFAULT_MAX_LENGTH.FIRST_NAME,
      minLength: 2,
      hubspotProperty: null,
      visibleWhen: null,
    },
    {
      fieldId: 'nachname',
      type: 'LAST_NAME',
      label: 'Nachname',
      helpText: null,
      placeholder: null,
      required: true,
      piiClass: 'PII',
      qualificationClass: 'NONE',
      normalization: DEFAULT_NORMALIZATION.LAST_NAME,
      maxLength: DEFAULT_MAX_LENGTH.LAST_NAME,
      minLength: 2,
      hubspotProperty: null,
      visibleWhen: null,
    },
    {
      fieldId: 'email',
      type: 'EMAIL',
      label: 'E-Mail-Adresse',
      helpText: 'An diese Adresse senden wir Ihre Auswertung.',
      placeholder: null,
      required: true,
      piiClass: 'PII',
      qualificationClass: 'NONE',
      normalization: DEFAULT_NORMALIZATION.EMAIL,
      maxLength: DEFAULT_MAX_LENGTH.EMAIL,
      hubspotProperty: null,
      visibleWhen: null,
    },
  ];

  if (input.collectCompany) {
    fields.push({
      fieldId: 'firma',
      type: 'SHORT_TEXT',
      label: 'Unternehmen',
      helpText: null,
      placeholder: null,
      required: true,
      piiClass: 'PII',
      qualificationClass: 'NONE',
      normalization: DEFAULT_NORMALIZATION.SHORT_TEXT,
      maxLength: DEFAULT_MAX_LENGTH.SHORT_TEXT,
      minLength: 2,
      hubspotProperty: null,
      visibleWhen: null,
    });
  }

  if (input.collectPhone !== false) {
    fields.push({
      fieldId: 'telefon',
      type: 'PHONE',
      label: 'Telefonnummer',
      helpText: 'Für Rückfragen zur Auswertung.',
      placeholder: null,
      required: true,
      piiClass: 'PII',
      qualificationClass: 'NONE',
      normalization: DEFAULT_NORMALIZATION.PHONE,
      maxLength: DEFAULT_MAX_LENGTH.PHONE,
      defaultCountry: '+49',
      hubspotProperty: null,
      visibleWhen: null,
    });
  }

  return fields;
}

/* -------------------------------------------------------------------------- */
/* buildDefaultMultiStepForm                                                   */
/* -------------------------------------------------------------------------- */

const NOT_A_FIT_VARIANT_ID = 'nicht_passend';

function bookingSpecFrom(draft: BookingDraft | null | undefined): BookingSpec | null {
  if (!draft) return null;
  const href = draft.href ?? null;
  return {
    mode: draft.mode ?? 'LINK',
    target: href === null ? null : { href, external: true, requiresAllowlist: true, newTab: false },
    label: draft.label ?? 'Termin auswählen',
    helpText: draft.helpText ?? null,
  };
}

/**
 * Builds the mandated default multi-step form.
 *
 * @throws {DomainError} `VALIDATION_FAILED` when the number of qualification
 * questions leaves the configured 4–7 window.
 */
export function buildDefaultMultiStepForm(input: BuildFormInput): MultiStepFormSpec {
  const questions = input.questions ?? defaultQualificationQuestions(input.angleName);

  if (
    questions.length < GENERATION_DEFAULTS.minQualificationQuestions ||
    questions.length > GENERATION_DEFAULTS.maxQualificationQuestions
  ) {
    throw new DomainError('VALIDATION_FAILED', {
      messageDe: `Ein mehrstufiges Formular benötigt ${GENERATION_DEFAULTS.minQualificationQuestions} bis ${GENERATION_DEFAULTS.maxQualificationQuestions} Qualifizierungsfragen (übergeben: ${questions.length}).`,
      details: { questionCount: questions.length },
    });
  }

  const offerLabel = input.offerName ?? OFFER_TYPE_LABELS_DE[input.offerType];
  const consentFieldId = input.consent.fieldId ?? 'einwilligung';
  const booking = bookingSpecFrom(input.booking);

  /* ---- fields ---- */
  const contact = contactFields(input);
  const fields: Record<string, FormField> = {};
  for (const draft of questions) fields[draft.key] = questionField(draft);

  fields.plz = {
    fieldId: 'plz',
    type: 'POSTCODE',
    country: 'DE',
    label: 'Postleitzahl',
    helpText: 'Wir prüfen, ob wir Ihre Region aktuell betreuen.',
    placeholder: null,
    required: true,
    /* Regional routing, not contact data — the postcode is asked before the
       contact step and must therefore not be classified as PII. */
    piiClass: 'QUALIFICATION',
    qualificationClass: 'ROUTING_ONLY',
    normalization: 'POSTCODE_DE',
    maxLength: 5,
    hubspotProperty: null,
    visibleWhen: null,
  };

  for (const field of contact) fields[field.fieldId] = field;

  fields[consentFieldId] = {
    fieldId: consentFieldId,
    type: 'CONSENT',
    consentVersionId: input.consent.consentVersionId,
    /* The full legal text is rendered from `spec.consent.textDe`; the field
       label stays short so it fits next to the checkbox. */
    label: input.consent.label ?? 'Einwilligung zur Datenverarbeitung',
    helpText: null,
    placeholder: null,
    required: true,
    piiClass: 'OPERATIONAL',
    qualificationClass: 'NONE',
    normalization: 'NONE',
    maxLength: DEFAULT_MAX_LENGTH.CONSENT,
    hubspotProperty: null,
    visibleWhen: null,
  };

  /* ---- steps ---- */
  const questionSteps: FormStep[] = questions.map((draft, index) => ({
    stepId: `frage_${index + 1}`,
    kind: 'QUESTION',
    title: draft.label,
    subtitle: null,
    fieldIds: [draft.key],
    primaryCtaLabel: 'Weiter',
    secondaryCtaLabel: index === 0 ? null : 'Zurück',
    showProgress: true,
    defaultNext: {
      kind: 'STEP',
      stepId: index + 2 <= questions.length ? `frage_${index + 2}` : 'standort',
    },
  }));

  const steps: FormStep[] = [
    ...questionSteps,
    {
      stepId: 'standort',
      kind: 'LOCATION',
      title: 'Wo befindet sich Ihr Unternehmen?',
      subtitle: 'Die Postleitzahl genügt.',
      fieldIds: ['plz'],
      primaryCtaLabel: 'Weiter',
      secondaryCtaLabel: 'Zurück',
      showProgress: true,
      defaultNext: { kind: 'STEP', stepId: 'kontakt' },
    },
    {
      stepId: 'kontakt',
      kind: 'CONTACT',
      title: 'Wohin dürfen wir das Ergebnis senden?',
      subtitle: `${offerLabel} — Sie erhalten das Ergebnis per E-Mail.`,
      fieldIds: [...contact.map((field) => field.fieldId), consentFieldId],
      primaryCtaLabel: 'Auswertung anfordern',
      secondaryCtaLabel: 'Zurück',
      showProgress: true,
      defaultNext: { kind: 'SUBMIT' },
    },
  ];

  /* ---- routing: disqualifying answers leave the flow immediately ---- */
  const routingRules: RoutingRule[] = [];
  const qualificationRules: QualificationRule[] = [];

  questions.forEach((draft, index) => {
    const blocking = (draft.options ?? []).filter((option) => option.disqualifying);
    if (blocking.length === 0) return;
    const optionIds = blocking.map((option) => option.id);
    const reasonCode = `NICHT_PASSEND_${draft.key.toUpperCase()}`;

    routingRules.push({
      ruleId: `routing_disq_${draft.key}`,
      fromStepId: `frage_${index + 1}`,
      when: anyOf(atom(draft.key, 'IN', optionIds)),
      target: { kind: 'DISQUALIFY', variantId: NOT_A_FIT_VARIANT_ID, reasonCode },
      description: `Bricht ab, wenn ${draft.label} eine ausschließende Antwort erhält.`,
    });

    qualificationRules.push({
      effect: 'DISQUALIFY',
      ruleId: `qual_disq_${draft.key}`,
      when: anyOf(atom(draft.key, 'IN', optionIds)),
      reasonCode,
      description: `Nicht passend aufgrund der Antwort auf ${draft.label}.`,
    });
  });

  /* ---- qualification thresholds derived from the achievable score ---- */
  const maxScore = questions.reduce((total, draft) => {
    const scores = (draft.options ?? []).map((option) => option.score ?? 0);
    if (scores.length === 0) return total;
    /* A multi-select can accumulate every positive option, a single select only
       its best one. */
    const best =
      draft.type === 'MULTI_SELECT'
        ? scores.filter((score) => score > 0).reduce((sum, score) => sum + score, 0)
        : Math.max(...scores);
    return total + best;
  }, 0);

  qualificationRules.push(
    {
      effect: 'CLASSIFY',
      ruleId: 'klasse_qualifiziert',
      when: null,
      minScore: Math.ceil(maxScore * 0.6),
      outcome: 'QUALIFIED',
      reasonCode: 'SCORE_HOCH',
      description: 'Ab 60 % der erreichbaren Punkte gilt eine Anfrage als qualifiziert.',
    },
    {
      effect: 'CLASSIFY',
      ruleId: 'klasse_pruefung',
      when: null,
      minScore: Math.ceil(maxScore * 0.3),
      outcome: 'NEEDS_REVIEW',
      reasonCode: 'SCORE_MITTEL',
      description: 'Ab 30 % der erreichbaren Punkte wird manuell geprüft.',
    },
    {
      effect: 'CLASSIFY',
      ruleId: 'klasse_nicht_passend',
      when: null,
      minScore: -1000,
      outcome: 'NOT_A_FIT',
      reasonCode: 'SCORE_ZU_NIEDRIG',
      description: 'Unter 30 % der erreichbaren Punkte passt das Angebot derzeit nicht.',
    },
  );

  /* ---- result variants ---- */
  /* The question whose best answer contributes most — used as the condition of
     the "besonderes Potenzial" section of an analysis result. */
  let strongest: { key: string; optionIds: string[]; top: number } | null = null;
  for (const draft of questions) {
    const options = draft.options ?? [];
    if (options.length === 0) continue;
    const top = Math.max(...options.map((option) => option.score ?? 0));
    if (top <= 0 || (strongest !== null && top <= strongest.top)) continue;
    strongest = {
      key: draft.key,
      top,
      optionIds: options.filter((option) => (option.score ?? 0) >= top).map((option) => option.id),
    };
  }

  const resultVariants: ResultVariant[] = [
    {
      kind: 'NOT_A_FIT',
      variantId: NOT_A_FIT_VARIANT_ID,
      forOutcomes: ['NOT_A_FIT'],
      showWhen: null,
      headline: 'Wir sind aktuell nicht die richtige Wahl',
      body: 'Vielen Dank für Ihre Angaben. Auf Basis Ihrer Antworten würden wir Ihnen heute kein sinnvolles Ergebnis liefern können — deshalb sagen wir das lieber offen, statt Ihnen einen Termin zu verkaufen.',
      alternativeNote:
        'Melden Sie sich gerne erneut, sobald sich Budget, Zeitplan oder Zielsetzung geändert haben.',
      cta: null,
    },
  ];

  if (booking) {
    resultVariants.push({
      kind: 'BOOKING',
      variantId: 'termin',
      forOutcomes: ['QUALIFIED'],
      showWhen: null,
      headline: 'Passt — wählen Sie Ihren Wunschtermin',
      body: 'Ihre Angaben deuten auf klares Potenzial hin. Im nächsten Schritt gehen wir Ihre Auswertung gemeinsam durch.',
      booking,
      bullets: ['30 Minuten', 'Konkrete Einschätzung statt Verkaufsgespräch'],
    });
  }

  const mainKind = input.resultKind ?? (booking ? 'BOOKING' : 'THANK_YOU');

  if (mainKind === 'ANALYSIS') {
    resultVariants.push({
      kind: 'ANALYSIS',
      variantId: 'analyse',
      forOutcomes: [],
      showWhen: null,
      headline: `Ihre ${offerLabel} ist unterwegs`,
      body: 'Ihre Antworten ergeben bereits ein erstes Bild. Die vollständige Auswertung erhalten Sie per E-Mail.',
      sections: [
        {
          key: 'einordnung',
          title: 'Ihre Einordnung',
          body: 'Wir vergleichen Ihre Angaben mit vergleichbaren Unternehmen und leiten daraus Ihren realistischen Handlungsspielraum ab.',
          showWhen: null,
        },
        ...(strongest
          ? [
              {
                key: 'potenzial',
                title: 'Besonderes Potenzial',
                body: 'Ihre Ausgangslage spricht dafür, dass sich zusätzliche Anfragen kurzfristig gewinnen lassen.',
                showWhen: anyOf(atom(strongest.key, 'IN', strongest.optionIds)),
              },
            ]
          : []),
        {
          key: 'naechste_schritte',
          title: 'Nächste Schritte',
          body: 'Wir melden uns innerhalb eines Werktages mit der ausführlichen Auswertung.',
          showWhen: null,
        },
      ],
      cta: null,
      methodNote:
        'Alle Aussagen beruhen auf Ihren Angaben und auf ausgewerteten Kampagnendaten — es handelt sich nicht um eine Garantie.',
    });
  } else if (mainKind === 'LEAD_MAGNET') {
    resultVariants.push({
      kind: 'LEAD_MAGNET',
      variantId: 'lead_magnet',
      forOutcomes: [],
      showWhen: null,
      headline: 'Ihr Download ist bereit',
      body: 'Vielen Dank. Sie erhalten die Unterlagen zusätzlich per E-Mail.',
      assetPath: null,
      assetLabel: offerLabel,
      deliveryNote: 'Sollte die E-Mail nicht ankommen, prüfen Sie bitte Ihren Spam-Ordner.',
    });
  } else if (mainKind === 'BOOKING' && booking) {
    resultVariants.push({
      kind: 'THANK_YOU',
      variantId: 'danke',
      forOutcomes: [],
      showWhen: null,
      headline: 'Vielen Dank für Ihre Angaben',
      body: 'Wir prüfen Ihre Angaben und melden uns innerhalb eines Werktages bei Ihnen.',
      bullets: [],
      cta: null,
    });
  } else {
    resultVariants.push({
      kind: 'THANK_YOU',
      variantId: 'danke',
      forOutcomes: [],
      showWhen: null,
      headline: 'Vielen Dank für Ihre Angaben',
      body: `Wir bereiten Ihre ${offerLabel} auf und melden uns innerhalb eines Werktages bei Ihnen.`,
      bullets: ['Auswertung per E-Mail', 'Keine automatische Newsletter-Anmeldung'],
      cta: null,
    });
  }

  const intro: IntroSpec = {
    eyebrow: input.intro?.eyebrow ?? offerLabel,
    headline: input.intro?.headline ?? input.title,
    subline:
      input.intro?.subline ??
      `In ${questions.length} kurzen Fragen prüfen wir, ob und wie ${input.angleName} für Ihr Unternehmen funktioniert.`,
    bullets: input.intro?.bullets ?? [
      'Kostenlos und unverbindlich',
      'Individuelle Auswertung statt Standardantwort',
    ],
    effortPromise: input.intro?.effortPromise ?? input.effortPromise ?? '2 Minuten',
    trustNote:
      input.intro?.trustNote ?? 'Ihre Daten werden ausschließlich für diese Anfrage genutzt.',
    primaryCtaLabel: input.intro?.primaryCtaLabel ?? 'Jetzt starten',
    media: input.intro?.media ?? null,
  };

  return {
    kind: 'MULTI_STEP_FORM',
    schemaVersion: SPEC_SCHEMA_VERSION,
    formId: input.formId,
    formVersionId: input.formVersionId,
    locale: 'de-DE',
    title: input.title,
    offerId: input.offerId,
    angleId: input.angleId,
    intro,
    steps,
    fields,
    routingRules,
    qualificationRules,
    resultVariants,
    consent: {
      fieldId: consentFieldId,
      required: true,
      defaultChecked: false,
      consentVersionId: input.consent.consentVersionId,
      textDe: input.consent.textDe,
      purposes: input.consent.purposes,
      privacyPolicyUrl: input.consent.privacyPolicyUrl,
    },
    submit: {
      endpointPath: input.submitEndpointPath ?? '/api/funnel/submit',
      submitLabel: 'Auswertung anfordern',
      submittingLabel: 'Wird gesendet …',
      errorMessage:
        'Ihre Anfrage konnte nicht übermittelt werden. Bitte versuchen Sie es in einem Moment erneut.',
      requireDoubleOptIn: false,
      honeypotFieldId: 'hp_website',
      minCompletionSeconds: 3,
      maxAttemptsPerHour: 10,
    },
    success: {
      headline: 'Vielen Dank — wir haben Ihre Anfrage erhalten',
      body: 'Sie erhalten in Kürze eine Bestätigung per E-Mail.',
      bullets: [],
      primaryCta: booking ? cta('Termin auswählen', 'BOOKING') : null,
      secondaryCta: null,
      booking,
      redirect: null,
      showAnswerSummary: false,
      legalNote: null,
    },
    theme: mergeTheme(input.theme),
  };
}

/* -------------------------------------------------------------------------- */
/* Page input                                                                  */
/* -------------------------------------------------------------------------- */

export interface HeroDraft {
  eyebrow?: string | null;
  headline: string;
  subline?: string | null;
  bullets?: string[];
  primaryCtaLabel: string;
  primaryCtaTarget?: LinkTarget | null;
  secondaryCtaLabel?: string | null;
  media?: MediaRef | null;
  trustNote?: string | null;
}

export interface LegalDraft {
  companyLine: string;
  imprintPath?: string;
  privacyPath?: string;
  disclaimers?: string[];
}

export interface BuildPageInput {
  pageId: string;
  pageVersionId: string;
  offerId: string;
  angleId: string;
  title: string;
  slug: string;
  hero: HeroDraft;
  problem?: {
    headline: string;
    intro?: string | null;
    points: { key: string; title: string; body: string }[];
  };
  benefits?: { headline: string; items: { key: string; title: string; body: string }[] };
  proof?: { headline: string; points: ProofPoint[]; sourceNote?: string | null };
  process?: {
    headline: string;
    intro?: string | null;
    steps: { key: string; title: string; body: string; durationNote?: string | null }[];
  };
  caseStudy?: {
    headline: string;
    caseStudyId?: string | null;
    client: string;
    industry?: string | null;
    challenge: string;
    approach: string;
    outcome: string;
    metrics?: { key: string; label: string; value: string }[];
  };
  testimonials?: {
    headline?: string | null;
    items: {
      key: string;
      testimonialId?: string | null;
      quote: string;
      authorName: string;
      authorRole?: string | null;
      company?: string | null;
    }[];
  };
  comparison?: {
    headline: string;
    intro?: string | null;
    columns: { key: string; label: string; highlight?: boolean }[];
    rows: { key: string; label: string; cells: string[] }[];
  };
  objections?: { headline: string; items: { key: string; objection: string; response: string }[] };
  faq?: {
    headline: string;
    items: { key: string; faqId?: string | null; question: string; answer: string }[];
  };
  trust?: {
    headline?: string | null;
    badges?: { key: string; label: string; note?: string | null }[];
    logos?: { key: string; label: string }[];
  };
  booking?: { headline: string; body: string; booking: BookingSpec };
  cta?: {
    headline: string;
    body?: string | null;
    label: string;
    target?: LinkTarget | null;
    urgencyNote?: string | null;
  };
  embeddedForm?: { headline: string; body?: string | null; form: EmbeddedFormRef };
  legal: LegalDraft;
  seo?: Partial<SeoSpec>;
  theme?: ThemeOverrides;
}

function buildBlocks(input: BuildPageInput, maxBlocks: number): PageBlock[] {
  const blocks: PageBlock[] = [];

  blocks.push({
    type: 'HERO',
    blockId: 'hero',
    anchor: 'start',
    eyebrow: input.hero.eyebrow ?? null,
    headline: input.hero.headline,
    subline: input.hero.subline ?? null,
    bullets: input.hero.bullets ?? [],
    primaryCta: cta(
      input.hero.primaryCtaLabel,
      input.hero.primaryCtaTarget ? 'LINK' : 'OPEN_FORM',
      input.hero.primaryCtaTarget ?? null,
    ),
    secondaryCta: input.hero.secondaryCtaLabel
      ? cta(input.hero.secondaryCtaLabel, 'LINK', anchorLink('ablauf'), 'GHOST')
      : null,
    media: input.hero.media ?? null,
    trustNote: input.hero.trustNote ?? null,
  });

  if (input.problem) {
    blocks.push({
      type: 'PROBLEM',
      blockId: 'problem',
      anchor: 'problem',
      headline: input.problem.headline,
      intro: input.problem.intro ?? null,
      points: input.problem.points,
    });
  }

  if (input.benefits) {
    blocks.push({
      type: 'BENEFIT',
      blockId: 'nutzen',
      anchor: 'nutzen',
      headline: input.benefits.headline,
      intro: null,
      benefits: input.benefits.items.map((item) => ({ ...item, iconKey: null })),
    });
  }

  if (input.proof) {
    blocks.push({
      type: 'PROOF',
      blockId: 'belege',
      anchor: 'belege',
      headline: input.proof.headline,
      points: input.proof.points,
      sourceNote: input.proof.sourceNote ?? null,
    });
  }

  if (input.process) {
    blocks.push({
      type: 'PROCESS',
      blockId: 'ablauf',
      anchor: 'ablauf',
      headline: input.process.headline,
      intro: input.process.intro ?? null,
      steps: input.process.steps.map((step) => ({
        ...step,
        durationNote: step.durationNote ?? null,
      })),
    });
  }

  if (input.caseStudy) {
    blocks.push({
      type: 'CASE_STUDY',
      blockId: 'fallstudie',
      anchor: 'fallstudie',
      headline: input.caseStudy.headline,
      caseStudyId: input.caseStudy.caseStudyId ?? null,
      client: input.caseStudy.client,
      industry: input.caseStudy.industry ?? null,
      challenge: input.caseStudy.challenge,
      approach: input.caseStudy.approach,
      outcome: input.caseStudy.outcome,
      metrics: input.caseStudy.metrics ?? [],
      cta: null,
    });
  }

  if (input.testimonials) {
    blocks.push({
      type: 'TESTIMONIAL',
      blockId: 'stimmen',
      anchor: 'stimmen',
      headline: input.testimonials.headline ?? null,
      testimonials: input.testimonials.items.map((item) => ({
        key: item.key,
        testimonialId: item.testimonialId ?? null,
        quote: item.quote,
        authorName: item.authorName,
        authorRole: item.authorRole ?? null,
        company: item.company ?? null,
        media: null,
      })),
    });
  }

  if (input.comparison) {
    blocks.push({
      type: 'COMPARISON',
      blockId: 'vergleich',
      anchor: 'vergleich',
      headline: input.comparison.headline,
      intro: input.comparison.intro ?? null,
      columns: input.comparison.columns.map((column) => ({
        key: column.key,
        label: column.label,
        highlight: column.highlight ?? false,
      })),
      rows: input.comparison.rows,
    });
  }

  if (input.objections) {
    blocks.push({
      type: 'OBJECTION_HANDLING',
      blockId: 'einwaende',
      anchor: 'einwaende',
      headline: input.objections.headline,
      objections: input.objections.items,
    });
  }

  if (input.faq) {
    blocks.push({
      type: 'FAQ',
      blockId: 'faq',
      anchor: 'faq',
      headline: input.faq.headline,
      items: input.faq.items.map((item) => ({ ...item, faqId: item.faqId ?? null })),
    });
  }

  if (input.trust) {
    blocks.push({
      type: 'TRUST',
      blockId: 'vertrauen',
      anchor: 'vertrauen',
      headline: input.trust.headline ?? null,
      badges: (input.trust.badges ?? []).map((badge) => ({
        key: badge.key,
        label: badge.label,
        note: badge.note ?? null,
      })),
      logos: (input.trust.logos ?? []).map((logo) => ({
        key: logo.key,
        label: logo.label,
        media: null,
      })),
    });
  }

  if (input.booking) {
    blocks.push({
      type: 'BOOKING_CTA',
      blockId: 'termin',
      anchor: 'termin',
      headline: input.booking.headline,
      body: input.booking.body,
      booking: input.booking.booking,
    });
  }

  if (input.embeddedForm) {
    blocks.push({
      type: 'EMBEDDED_CONTACT',
      blockId: 'formular',
      anchor: 'formular',
      headline: input.embeddedForm.headline,
      body: input.embeddedForm.body ?? null,
      form: input.embeddedForm.form,
    });
  }

  if (input.cta) {
    blocks.push({
      type: 'CTA',
      blockId: 'abschluss_cta',
      anchor: 'jetzt_starten',
      headline: input.cta.headline,
      body: input.cta.body ?? null,
      cta: cta(input.cta.label, input.cta.target ? 'LINK' : 'OPEN_FORM', input.cta.target ?? null),
      urgencyNote: input.cta.urgencyNote ?? null,
    });
  }

  const legal: PageBlock = {
    type: 'FOOTER_LEGAL',
    blockId: 'rechtliches',
    anchor: null,
    companyLine: input.legal.companyLine,
    imprintLink: internalLink(input.legal.imprintPath ?? '/impressum'),
    privacyLink: internalLink(input.legal.privacyPath ?? '/datenschutz'),
    additionalLinks: [],
    disclaimers: input.legal.disclaimers ?? [],
  };

  /* The legal footer is never dropped when the page is trimmed for a hybrid. */
  const trimmed = blocks.slice(0, Math.max(1, maxBlocks - 1));
  trimmed.push(legal);
  return trimmed;
}

function seoFor(input: BuildPageInput): SeoSpec {
  return {
    metaTitle: input.seo?.metaTitle ?? input.title.slice(0, 70),
    metaDescription: input.seo?.metaDescription ?? input.hero.headline.slice(0, 180),
    /* Paid funnel pages stay out of the index unless explicitly requested. */
    noindex: input.seo?.noindex ?? true,
    canonicalPath: input.seo?.canonicalPath ?? null,
  };
}

export function buildDefaultLandingPage(input: BuildPageInput): LandingPageSpec {
  return {
    kind: 'LANDING_PAGE',
    schemaVersion: SPEC_SCHEMA_VERSION,
    pageId: input.pageId,
    pageVersionId: input.pageVersionId,
    locale: 'de-DE',
    title: input.title,
    slug: input.slug,
    offerId: input.offerId,
    angleId: input.angleId,
    blocks: buildBlocks(input, 30),
    seo: seoFor(input),
    theme: mergeTheme(input.theme),
  };
}

export interface BuildHybridInput extends BuildPageInput {
  form: EmbeddedFormRef;
  /** Optional inline copy of the referenced form, for fixtures and previews. */
  formSpec?: MultiStepFormSpec | null;
}

/** A short page plus an embedded or modal multi-step form. */
export function buildDefaultHybrid(input: BuildHybridInput): HybridFunnelSpec {
  const blocks = buildBlocks(input, 8);
  const anchorBlockId =
    input.form.anchorBlockId && blocks.some((block) => block.blockId === input.form.anchorBlockId)
      ? input.form.anchorBlockId
      : null;

  return {
    kind: 'HYBRID',
    schemaVersion: SPEC_SCHEMA_VERSION,
    pageId: input.pageId,
    pageVersionId: input.pageVersionId,
    locale: 'de-DE',
    title: input.title,
    slug: input.slug,
    offerId: input.offerId,
    angleId: input.angleId,
    blocks,
    form: { ...input.form, anchorBlockId },
    formSpec: input.formSpec ?? null,
    seo: seoFor(input),
    theme: mergeTheme(input.theme),
  };
}
