import type { ConditionOperator, FieldType, PiiClass, QualificationClass } from '@am/domain';
import type {
  BookingMode,
  CtaAction,
  CtaStyle,
  EmbedMode,
  MediaAspect,
  NormalizationRule,
  QualificationRule,
  ResultVariant,
  StepKind,
  StepTarget,
} from '@am/funnel-schema';

/**
 * Every German word the builders render for a machine-readable spec value.
 *
 * Kept in one place so an operator never sees `SINGLE_SELECT` or `NOT_IN` in
 * the interface, and so the wording stays identical between the editor, the
 * preview and the validation summary.
 */

export const FIELD_TYPE_LABELS_DE: Readonly<Record<FieldType, string>> = {
  SINGLE_SELECT: 'Einfachauswahl',
  MULTI_SELECT: 'Mehrfachauswahl',
  BOOLEAN: 'Ja / Nein',
  NUMBER: 'Zahl',
  RANGE: 'Schieberegler',
  SHORT_TEXT: 'Kurzer Text',
  LONG_TEXT: 'Langer Text',
  POSTCODE: 'Postleitzahl',
  EMAIL: 'E-Mail-Adresse',
  PHONE: 'Telefonnummer',
  FIRST_NAME: 'Vorname',
  LAST_NAME: 'Nachname',
  CONSENT: 'Einwilligung',
};

export const FIELD_TYPE_HINTS_DE: Readonly<Record<FieldType, string>> = {
  SINGLE_SELECT: 'Eine Antwort aus mehreren Optionen.',
  MULTI_SELECT: 'Mehrere Antworten gleichzeitig möglich.',
  BOOLEAN: 'Zwei Antwortmöglichkeiten mit frei wählbaren Beschriftungen.',
  NUMBER: 'Zahleneingabe mit Ober- und Untergrenze.',
  RANGE: 'Schieberegler zwischen zwei Werten.',
  SHORT_TEXT: 'Einzeilige Freitextantwort.',
  LONG_TEXT: 'Mehrzeilige Freitextantwort.',
  POSTCODE: 'Fünfstellige deutsche Postleitzahl.',
  EMAIL: 'Wird als personenbezogenes Datum behandelt.',
  PHONE: 'Wird als personenbezogenes Datum behandelt.',
  FIRST_NAME: 'Wird als personenbezogenes Datum behandelt.',
  LAST_NAME: 'Wird als personenbezogenes Datum behandelt.',
  CONSENT: 'Einwilligungskästchen. Startet immer leer.',
};

export const OPERATOR_LABELS_DE: Readonly<Record<ConditionOperator, string>> = {
  EQUALS: 'ist gleich',
  NOT_EQUALS: 'ist nicht gleich',
  IN: 'ist eine von',
  NOT_IN: 'ist keine von',
  GREATER_THAN: 'ist größer als',
  LESS_THAN: 'ist kleiner als',
  IS_EMPTY: 'ist leer',
  IS_NOT_EMPTY: 'ist ausgefüllt',
};

export const STEP_KIND_LABELS_DE: Readonly<Record<StepKind, string>> = {
  QUESTION: 'Frage',
  LOCATION: 'Standort',
  CONTACT: 'Kontaktdaten',
  CONSENT: 'Einwilligung',
  REVIEW: 'Zusammenfassung',
};

export const TARGET_KIND_LABELS_DE: Readonly<Record<StepTarget['kind'], string>> = {
  STEP: 'weiter zu Schritt',
  SUBMIT: 'Formular absenden',
  RESULT: 'Ergebnisseite anzeigen',
  DISQUALIFY: 'als nicht passend beenden',
};

export const RESULT_KIND_LABELS_DE: Readonly<Record<ResultVariant['kind'], string>> = {
  THANK_YOU: 'Danke-Seite',
  LEAD_MAGNET: 'Download / Lead-Magnet',
  ANALYSIS: 'Analyse-Ergebnis',
  QUALIFIED: 'Qualifiziert',
  NOT_A_FIT: 'Nicht passend',
  BOOKING: 'Terminbuchung',
  REDIRECT: 'Weiterleitung',
};

export const RESULT_KIND_HINTS_DE: Readonly<Record<ResultVariant['kind'], string>> = {
  THANK_YOU: 'Kurze Bestätigung mit optionalen Stichpunkten.',
  LEAD_MAGNET: 'Bestätigung plus Hinweis auf die Unterlagen.',
  ANALYSIS: 'Abschnitte, die je nach Antworten ein- oder ausgeblendet werden.',
  QUALIFIED: 'Bestätigung für passende Anfragen, optional mit Terminbuchung.',
  NOT_A_FIT: 'Ehrliche Absage mit Alternative statt Terminangebot.',
  BOOKING: 'Direkte Terminbuchung als Abschluss.',
  REDIRECT: 'Weiterleitung auf ein freigegebenes Ziel.',
};

export const QUALIFICATION_EFFECT_LABELS_DE: Readonly<
  Record<QualificationRule['effect'], string>
> = {
  SCORE: 'Punkte vergeben',
  DISQUALIFY: 'Sofort disqualifizieren',
  QUALIFY: 'Sofort qualifizieren',
  CLASSIFY: 'Punktzahl einordnen',
};

export const QUALIFICATION_EFFECT_HINTS_DE: Readonly<
  Record<QualificationRule['effect'], string>
> = {
  SCORE: 'Addiert Punkte, wenn die Bedingung zutrifft.',
  DISQUALIFY: 'Setzt das Ergebnis unwiderruflich auf „Nicht passend“.',
  QUALIFY: 'Setzt das Ergebnis auf „Qualifiziert“, sofern nichts disqualifiziert.',
  CLASSIFY: 'Ordnet die erreichte Punktzahl einem Ergebnis zu. Höchster Schwellenwert gewinnt.',
};

export const PII_CLASS_LABELS_DE: Readonly<Record<PiiClass, string>> = {
  PII: 'Personenbezogen',
  QUALIFICATION: 'Qualifizierung',
  OPERATIONAL: 'Betrieblich',
};

export const QUALIFICATION_CLASS_LABELS_DE: Readonly<Record<QualificationClass, string>> = {
  NONE: 'Ohne Bewertung',
  SCORING: 'Zählt für die Punktzahl',
  DISQUALIFYING: 'Kann disqualifizieren',
  ROUTING_ONLY: 'Nur für Verzweigungen',
};

export const NORMALIZATION_LABELS_DE: Readonly<Record<NormalizationRule, string>> = {
  NONE: 'Unverändert übernehmen',
  TRIM: 'Leerzeichen am Rand entfernen',
  COLLAPSE_WHITESPACE: 'Mehrfache Leerzeichen zusammenfassen',
  LOWERCASE: 'In Kleinbuchstaben umwandeln',
  EMAIL: 'Als E-Mail-Adresse normalisieren',
  PHONE_E164: 'Als Telefonnummer normalisieren',
  POSTCODE_DE: 'Als deutsche Postleitzahl normalisieren',
  DIGITS_ONLY: 'Nur Ziffern behalten',
  INTEGER: 'Auf ganze Zahl runden',
};

export const SELECT_DISPLAY_LABELS_DE: Readonly<Record<'CARDS' | 'RADIO' | 'DROPDOWN', string>> = {
  CARDS: 'Große Auswahlkacheln',
  RADIO: 'Auswahlknöpfe',
  DROPDOWN: 'Aufklappliste',
};

export const CTA_ACTION_LABELS_DE: Readonly<Record<CtaAction, string>> = {
  NEXT_STEP: 'Zum nächsten Schritt',
  SUBMIT: 'Formular absenden',
  LINK: 'Zu einem Ziel verlinken',
  OPEN_FORM: 'Formular öffnen',
  BOOKING: 'Terminbuchung öffnen',
};

export const CTA_STYLE_LABELS_DE: Readonly<Record<CtaStyle, string>> = {
  PRIMARY: 'Hauptaktion',
  SECONDARY: 'Nebenaktion',
  GHOST: 'Dezent',
};

export const BOOKING_MODE_LABELS_DE: Readonly<Record<BookingMode, string>> = {
  LINK: 'Als Link öffnen',
  EMBED: 'Eingebettet anzeigen',
};

export const EMBED_MODE_LABELS_DE: Readonly<Record<EmbedMode, string>> = {
  INLINE: 'Direkt auf der Seite',
  MODAL: 'Im Overlay nach Klick',
};

export const MEDIA_ASPECT_LABELS_DE: Readonly<Record<MediaAspect, string>> = {
  '1:1': 'Quadratisch (1:1)',
  '4:5': 'Hochformat (4:5)',
  '16:9': 'Querformat (16:9)',
  '9:16': 'Story (9:16)',
  '3:2': 'Foto (3:2)',
};

/** Copy that explains why an answer id can never be edited after creation. */
export const OPTION_ID_FROZEN_NOTE_DE =
  'Die Antwort-Kennung wird einmalig aus der Beschriftung abgeleitet und danach nicht mehr geändert. ' +
  'Regeln, Auswertungen und das CRM speichern diese Kennung: Würde sie nach der Veröffentlichung wechseln, ' +
  'bekämen bereits erfasste Antworten stillschweigend eine neue Bedeutung. Die sichtbare Beschriftung ' +
  'dürfen Sie jederzeit umformulieren.';

export const PUBLISHED_IMMUTABLE_NOTE_DE =
  'Diese Version ist veröffentlicht und damit unveränderlich. Sie sehen sie hier nur lesend. ' +
  'Über „Als neuen Entwurf bearbeiten“ entsteht eine neue Entwurfsversion — die veröffentlichte ' +
  'Version bleibt unangetastet, bis der Entwurf selbst veröffentlicht wird.';

export const PREVIEW_MARKER_DE = 'Vorschau — nicht die veröffentlichte Strecke';
