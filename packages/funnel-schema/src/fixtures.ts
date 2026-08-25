import { type Answers } from './evaluate';
import {
  buildDefaultHybrid,
  buildDefaultLandingPage,
  buildDefaultMultiStepForm,
  type BuildFormInput,
  type BuildPageInput,
  type QuestionDraft,
} from './generate';
import { type MultiStepFormSpec } from './form-spec';
import { type HybridFunnelSpec, type LandingPageSpec } from './page-spec';

/**
 * Realistic German example specs.
 *
 * Used by the demo seed, by other packages' tests and by the E2E suite, so the
 * same funnel is exercised end to end. The content is fictional but concrete —
 * a placeholder funnel would hide exactly the layout, length and branching
 * problems these fixtures exist to surface.
 *
 * Every identifier is a stable, hard-coded UUID: a fixture that changes shape
 * between runs is useless for snapshot and E2E assertions.
 */

export const FIXTURE_IDS = {
  formId: '7f1d3c2a-5b64-4a19-9e2f-1c0b8d4e6a01',
  formVersionId: '7f1d3c2a-5b64-4a19-9e2f-1c0b8d4e6a02',
  offerId: '7f1d3c2a-5b64-4a19-9e2f-1c0b8d4e6a03',
  angleId: '7f1d3c2a-5b64-4a19-9e2f-1c0b8d4e6a04',
  consentVersionId: '7f1d3c2a-5b64-4a19-9e2f-1c0b8d4e6a05',
  landingPageId: '7f1d3c2a-5b64-4a19-9e2f-1c0b8d4e6a06',
  landingPageVersionId: '7f1d3c2a-5b64-4a19-9e2f-1c0b8d4e6a07',
  hybridPageId: '7f1d3c2a-5b64-4a19-9e2f-1c0b8d4e6a08',
  hybridPageVersionId: '7f1d3c2a-5b64-4a19-9e2f-1c0b8d4e6a09',
  evidenceItemId: '7f1d3c2a-5b64-4a19-9e2f-1c0b8d4e6a10',
  caseStudyId: '7f1d3c2a-5b64-4a19-9e2f-1c0b8d4e6a11',
  testimonialId: '7f1d3c2a-5b64-4a19-9e2f-1c0b8d4e6a12',
  faqId: '7f1d3c2a-5b64-4a19-9e2f-1c0b8d4e6a13',
} as const;

export const FIXTURE_CONSENT_TEXT_DE =
  'Ich willige ein, dass meine Angaben zur Bearbeitung meiner Anfrage sowie zur Kontaktaufnahme per E-Mail und Telefon verarbeitet werden. Die Einwilligung kann ich jederzeit mit Wirkung für die Zukunft widerrufen. Details stehen in der Datenschutzerklärung.';

export const FIXTURE_ANGLE_NAME = 'planbare Anfragen statt Empfehlungsglück';

/* -------------------------------------------------------------------------- */
/* Potenzialanalyse — multi-step form                                          */
/* -------------------------------------------------------------------------- */

export const POTENZIALANALYSE_QUESTIONS: QuestionDraft[] = [
  {
    key: 'rolle',
    label: 'Welche Rolle haben Sie im Betrieb?',
    helpText: 'So schneiden wir die Auswertung auf Ihre Entscheidungssituation zu.',
    options: [
      { id: 'geschaeftsfuehrung', label: 'Geschäftsführung oder Inhaber:in', score: 4 },
      { id: 'marketing', label: 'Marketing', score: 3 },
      { id: 'vertrieb', label: 'Vertrieb', score: 2 },
      { id: 'sonstige', label: 'Andere Rolle', score: 0 },
    ],
  },
  {
    key: 'anfragequellen',
    label: 'Woher kommen Ihre Anfragen heute überwiegend?',
    helpText: 'Mehrfachauswahl möglich.',
    type: 'MULTI_SELECT',
    minSelected: 1,
    maxSelected: 4,
    options: [
      { id: 'empfehlung', label: 'Empfehlungen und Mundpropaganda', score: 3 },
      { id: 'bestandskunden', label: 'Bestandskunden', score: 2 },
      { id: 'google', label: 'Google-Suche', score: 2 },
      { id: 'social', label: 'Social Media', score: 1 },
    ],
  },
  {
    key: 'anfragen_pro_monat',
    label: 'Wie viele qualifizierte Anfragen erhalten Sie pro Monat?',
    options: [
      { id: 'keine', label: 'Praktisch keine', score: 1 },
      { id: 'bis_10', label: 'Bis zu 10', score: 3 },
      { id: 'bis_30', label: '11 bis 30', score: 4 },
      { id: 'ueber_30', label: 'Mehr als 30', score: 2 },
    ],
  },
  {
    key: 'werbebudget',
    label: 'Welches monatliche Werbebudget steht zur Verfügung?',
    helpText: 'Reines Mediabudget, ohne Agenturhonorar.',
    options: [
      { id: 'unter_500', label: 'Unter 500 €', score: 0, disqualifying: true },
      { id: 'von_500_bis_1500', label: '500 € bis 1.500 €', score: 2 },
      { id: 'von_1500_bis_4000', label: '1.500 € bis 4.000 €', score: 4 },
      { id: 'ueber_4000', label: 'Mehr als 4.000 €', score: 5 },
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

export const POTENZIALANALYSE_FORM_INPUT: BuildFormInput = {
  formId: FIXTURE_IDS.formId,
  formVersionId: FIXTURE_IDS.formVersionId,
  offerId: FIXTURE_IDS.offerId,
  angleId: FIXTURE_IDS.angleId,
  title: 'Kostenlose Potenzialanalyse für Ihren Betrieb',
  offerType: 'POTENTIAL_ANALYSIS',
  angleName: FIXTURE_ANGLE_NAME,
  offerName: 'Potenzialanalyse',
  questions: POTENZIALANALYSE_QUESTIONS,
  resultKind: 'ANALYSIS',
  collectPhone: true,
  collectCompany: true,
  intro: {
    eyebrow: 'Potenzialanalyse',
    headline: 'Wie viele qualifizierte Anfragen sind für Ihren Betrieb realistisch?',
    subline:
      'Fünf kurze Fragen. Danach wissen Sie, ob sich Meta-Werbung für Ihren Betrieb rechnet — und ab welchem Budget.',
    bullets: [
      'Individuelle Auswertung statt Standardantwort',
      'Kostenlos und unverbindlich',
      'Kein Verkaufsgespräch ohne Ihre Zustimmung',
    ],
    effortPromise: '2 Minuten',
    trustNote: 'Ihre Angaben werden ausschließlich für diese Anfrage verwendet.',
    primaryCtaLabel: 'Analyse starten',
    media: null,
  },
  consent: {
    consentVersionId: FIXTURE_IDS.consentVersionId,
    textDe: FIXTURE_CONSENT_TEXT_DE,
    purposes: ['CONTACT', 'AD_MEASUREMENT'],
    privacyPolicyUrl: '/datenschutz',
  },
};

/** A Potenzialanalyse with five qualification questions and one disqualifier. */
export const POTENZIALANALYSE_FORM_SPEC: MultiStepFormSpec = buildDefaultMultiStepForm(
  POTENZIALANALYSE_FORM_INPUT,
);

/* -------------------------------------------------------------------------- */
/* Answer sets                                                                 */
/* -------------------------------------------------------------------------- */

/** A visitor who is clearly a fit — reaches the contact step and submits. */
export const QUALIFIED_ANSWERS: Answers = {
  rolle: 'geschaeftsfuehrung',
  anfragequellen: ['empfehlung', 'bestandskunden'],
  anfragen_pro_monat: 'bis_10',
  werbebudget: 'ueber_4000',
  zeitpunkt: 'sofort',
  plz: '48431',
  vorname: 'Katrin',
  nachname: 'Bergmann',
  firma: 'Bergmann Haustechnik GmbH',
  email: 'k.bergmann@bergmann-haustechnik.de',
  telefon: '+49 2571 987654',
  einwilligung: true,
};

/** A visitor whose budget disqualifies them on the fourth question. */
export const DISQUALIFIED_ANSWERS: Answers = {
  rolle: 'sonstige',
  anfragequellen: ['social'],
  anfragen_pro_monat: 'keine',
  werbebudget: 'unter_500',
};

/** Two questions answered — used for progress and resume scenarios. */
export const PARTIAL_ANSWERS: Answers = {
  rolle: 'marketing',
  anfragequellen: ['google'],
};

/* -------------------------------------------------------------------------- */
/* Landing page                                                                */
/* -------------------------------------------------------------------------- */

const LANDING_PAGE_INPUT: BuildPageInput = {
  pageId: FIXTURE_IDS.landingPageId,
  pageVersionId: FIXTURE_IDS.landingPageVersionId,
  offerId: FIXTURE_IDS.offerId,
  angleId: FIXTURE_IDS.angleId,
  title: 'Planbare Anfragen für Handwerk und Mittelstand',
  slug: 'potenzialanalyse-handwerk',
  hero: {
    eyebrow: 'Für Betriebe mit 10 bis 50 Mitarbeitenden',
    headline: 'Planbare Anfragen statt Empfehlungsglück',
    subline:
      'Wir bauen für Handwerks- und Mittelstandsbetriebe Anfragestrecken, die auch dann liefern, wenn gerade niemand weiterempfiehlt.',
    bullets: [
      'Anfragen, die zu Ihrem Leistungsangebot passen',
      'Transparente Zahlen statt Agentur-Blabla',
      'Start ohne langfristige Bindung',
    ],
    primaryCtaLabel: 'Kostenlose Potenzialanalyse starten',
    secondaryCtaLabel: 'So läuft es ab',
    trustNote: 'Über 40 Betriebe betreut. Keine Erfolgsversprechen, nur nachvollziehbare Zahlen.',
  },
  problem: {
    headline: 'Warum gute Betriebe zu wenige Anfragen bekommen',
    intro:
      'Die Auftragslage schwankt nicht, weil die Arbeit schlechter wird — sondern weil die Anfragen aus einer einzigen, unsteuerbaren Quelle stammen.',
    points: [
      {
        key: 'abhaengigkeit',
        title: 'Abhängigkeit von Empfehlungen',
        body: 'Empfehlungen sind wertvoll, aber nicht planbar. Fällt ein großer Empfehlungsgeber weg, bricht die Pipeline innerhalb weniger Wochen ein.',
      },
      {
        key: 'falsche_anfragen',
        title: 'Zu viele unpassende Anfragen',
        body: 'Wer breit wirbt, bekommt Preisanfragen statt Projekte. Das kostet Zeit im Büro und Motivation im Vertrieb.',
      },
      {
        key: 'keine_zahlen',
        title: 'Keine belastbaren Zahlen',
        body: 'Ohne saubere Messung bleibt offen, welcher Kanal wirklich Aufträge bringt — und welcher nur Klicks liefert.',
      },
    ],
  },
  benefits: {
    headline: 'Was sich dadurch ändert',
    items: [
      {
        key: 'planbarkeit',
        title: 'Planbare Auslastung',
        body: 'Sie sehen, wie viele Anfragen ein bestimmtes Budget erzeugt, und können Personalplanung darauf aufbauen.',
      },
      {
        key: 'qualitaet',
        title: 'Passendere Anfragen',
        body: 'Vorqualifizierung über das Anfrageformular filtert Projekte heraus, die nicht zu Ihrem Angebot passen.',
      },
      {
        key: 'transparenz',
        title: 'Nachvollziehbare Zahlen',
        body: 'Jede Anfrage ist einer Kampagne zugeordnet. Sie sehen Kosten pro Anfrage und pro gewonnenem Auftrag.',
      },
    ],
  },
  proof: {
    headline: 'Was wir belegen können — und was nicht',
    points: [
      {
        key: 'betriebe',
        label: 'Betreute Betriebe',
        value: 'über 40',
        note: 'Stand der letzten internen Auswertung.',
        evidenceItemId: FIXTURE_IDS.evidenceItemId,
        confidence: 'FACT',
      },
      {
        key: 'anlaufzeit',
        label: 'Typische Anlaufzeit bis zu den ersten Anfragen',
        value: '2 bis 4 Wochen',
        note: 'Erfahrungswert aus vergleichbaren Projekten, keine Zusage.',
        evidenceItemId: null,
        confidence: 'INDICATION',
      },
    ],
    sourceNote:
      'Zahlen stammen aus eigenen Kampagnendaten. Ergebnisse einzelner Betriebe lassen sich nicht übertragen.',
  },
  process: {
    headline: 'So läuft die Zusammenarbeit ab',
    intro: 'Vier Schritte, keine Überraschungen.',
    steps: [
      {
        key: 'analyse',
        title: 'Potenzialanalyse',
        body: 'Sie beantworten fünf Fragen, wir rechnen aus, welches Anfragevolumen bei welchem Budget realistisch ist.',
        durationNote: '2 Minuten',
      },
      {
        key: 'gespraech',
        title: 'Auswertungsgespräch',
        body: 'Wir gehen die Auswertung gemeinsam durch und sagen offen, wenn wir nicht die richtige Wahl sind.',
        durationNote: '30 Minuten',
      },
      {
        key: 'aufbau',
        title: 'Aufbau der Anfragestrecke',
        body: 'Wir erstellen Werbemittel, Anfrageformular und Messung und stimmen alles mit Ihnen ab.',
        durationNote: '2 Wochen',
      },
      {
        key: 'betrieb',
        title: 'Betrieb und Optimierung',
        body: 'Monatlicher Bericht mit Kosten pro Anfrage, Abschlussquote und den nächsten Schritten.',
        durationNote: 'laufend',
      },
    ],
  },
  caseStudy: {
    headline: 'Beispiel aus der Praxis',
    caseStudyId: FIXTURE_IDS.caseStudyId,
    client: 'Sanitärbetrieb mit 24 Mitarbeitenden',
    industry: 'Handwerk',
    challenge:
      'Der Betrieb war vollständig von Empfehlungen abhängig. Nach dem Wegfall eines Bauträgers als Auftraggeber fehlten kurzfristig planbare Projekte.',
    approach:
      'Aufbau einer Anfragestrecke mit vorqualifizierendem Formular, klarer Leistungsabgrenzung und wöchentlicher Auswertung.',
    outcome:
      'Nach acht Wochen kamen die Anfragen aus zwei statt aus einer Quelle. Die Angebotsquote blieb stabil, die Streuung ging deutlich zurück.',
    metrics: [
      { key: 'anfragen', label: 'Anfragen pro Monat', value: '9 bis 14' },
      { key: 'kosten', label: 'Kosten pro Anfrage', value: '38 € bis 62 €' },
    ],
  },
  testimonials: {
    headline: 'Was Betriebe sagen',
    items: [
      {
        key: 'stimme_1',
        testimonialId: FIXTURE_IDS.testimonialId,
        quote:
          'Zum ersten Mal weiß ich morgens, wie viele Anfragen diese Woche kommen. Das klingt banal, ändert aber die gesamte Personalplanung.',
        authorName: 'Katrin Bergmann',
        authorRole: 'Geschäftsführerin',
        company: 'Bergmann Haustechnik GmbH',
      },
    ],
  },
  comparison: {
    headline: 'Empfehlung, Portal oder eigene Anfragestrecke?',
    intro: 'Alle drei Wege funktionieren — aber nicht gleich gut steuerbar.',
    columns: [
      { key: 'empfehlung', label: 'Empfehlung' },
      { key: 'portal', label: 'Portale' },
      { key: 'eigene', label: 'Eigene Strecke', highlight: true },
    ],
    rows: [
      {
        key: 'planbarkeit',
        label: 'Planbarkeit',
        cells: ['Zufällig', 'Schwankend', 'Über Budget steuerbar'],
      },
      {
        key: 'qualitaet',
        label: 'Passgenauigkeit',
        cells: ['Sehr hoch', 'Gering, oft Preisanfragen', 'Über Fragen steuerbar'],
      },
      {
        key: 'kosten',
        label: 'Kostenstruktur',
        cells: ['Keine direkten Kosten', 'Pro Lead, oft geteilt', 'Pro Anfrage, exklusiv'],
      },
    ],
  },
  objections: {
    headline: 'Häufige Einwände — ehrlich beantwortet',
    items: [
      {
        key: 'zu_klein',
        objection: 'Wir sind zu klein für Werbung.',
        response:
          'Unterhalb von etwa 500 € Mediabudget im Monat lohnt sich der Aufbau tatsächlich nicht. Genau deshalb fragen wir das Budget vorab ab und sagen ab, wenn es nicht passt.',
      },
      {
        key: 'keine_zeit',
        objection: 'Wir haben keine Zeit für noch ein Projekt.',
        response:
          'Der Aufwand auf Ihrer Seite liegt bei etwa zwei Stunden im Aufbau und 30 Minuten im Monat für den Bericht.',
      },
      {
        key: 'schon_versucht',
        objection: 'Wir haben Werbung schon einmal erfolglos versucht.',
        response:
          'Meist fehlten Vorqualifizierung und Messung. Wir starten deshalb mit dem Anfrageformular, nicht mit der Anzeige.',
      },
    ],
  },
  faq: {
    headline: 'Häufige Fragen',
    items: [
      {
        key: 'laufzeit',
        faqId: FIXTURE_IDS.faqId,
        question: 'Gibt es eine Mindestlaufzeit?',
        answer:
          'Die Zusammenarbeit ist monatlich kündbar. Für belastbare Zahlen empfehlen wir mindestens drei Monate.',
      },
      {
        key: 'budget',
        faqId: null,
        question: 'Welches Budget ist sinnvoll?',
        answer:
          'Ab etwa 500 € Mediabudget im Monat lassen sich erste Aussagen treffen. Was für Sie realistisch ist, zeigt die Potenzialanalyse.',
      },
      {
        key: 'daten',
        faqId: null,
        question: 'Was passiert mit meinen Daten?',
        answer:
          'Ihre Angaben werden ausschließlich zur Bearbeitung Ihrer Anfrage genutzt und nicht an Dritte verkauft.',
      },
    ],
  },
  trust: {
    headline: 'Womit wir arbeiten',
    badges: [
      { key: 'dsgvo', label: 'Verarbeitung nach DSGVO', note: 'Server in der EU' },
      { key: 'transparenz', label: 'Monatlicher Zahlenbericht', note: null },
    ],
    logos: [],
  },
  cta: {
    headline: 'Zwei Minuten für eine ehrliche Einschätzung',
    body: 'Die Potenzialanalyse sagt Ihnen, welches Anfragevolumen bei welchem Budget realistisch ist — auch wenn die Antwort lautet, dass sich der Aufbau für Sie noch nicht lohnt.',
    label: 'Potenzialanalyse starten',
    urgencyNote: null,
  },
  legal: {
    companyLine: 'A&M Marketing GmbH, Musterstraße 1, 48431 Rheine',
    disclaimers: [
      'Alle genannten Werte sind Erfahrungswerte aus vergleichbaren Projekten und keine zugesicherten Ergebnisse.',
    ],
  },
};

export const LANDING_PAGE_SPEC: LandingPageSpec = buildDefaultLandingPage(LANDING_PAGE_INPUT);

/* -------------------------------------------------------------------------- */
/* Hybrid funnel                                                               */
/* -------------------------------------------------------------------------- */

export const HYBRID_FUNNEL_SPEC: HybridFunnelSpec = buildDefaultHybrid({
  ...LANDING_PAGE_INPUT,
  pageId: FIXTURE_IDS.hybridPageId,
  pageVersionId: FIXTURE_IDS.hybridPageVersionId,
  title: 'Potenzialanalyse — Kurzstrecke',
  slug: 'potenzialanalyse-kurz',
  hero: {
    ...LANDING_PAGE_INPUT.hero,
    secondaryCtaLabel: null,
  },
  proof: undefined,
  caseStudy: undefined,
  comparison: undefined,
  objections: undefined,
  faq: undefined,
  cta: undefined,
  form: {
    mode: 'MODAL',
    formId: FIXTURE_IDS.formId,
    formVersionId: FIXTURE_IDS.formVersionId,
    triggerLabel: 'Potenzialanalyse starten',
    anchorBlockId: 'hero',
  },
  formSpec: POTENZIALANALYSE_FORM_SPEC,
});

/* -------------------------------------------------------------------------- */
/* Convenience                                                                 */
/* -------------------------------------------------------------------------- */

export interface FunnelFixtures {
  form: MultiStepFormSpec;
  landingPage: LandingPageSpec;
  hybrid: HybridFunnelSpec;
}

/** All three fixtures at once — used by the demo seed and the E2E setup. */
export function funnelFixtures(): FunnelFixtures {
  return {
    form: POTENZIALANALYSE_FORM_SPEC,
    landingPage: LANDING_PAGE_SPEC,
    hybrid: HYBRID_FUNNEL_SPEC,
  };
}
