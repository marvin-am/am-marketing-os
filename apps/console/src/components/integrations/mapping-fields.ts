import { CONDITION_OPERATORS, SALES_EVENT_TYPES, VQ_STATUSES } from '@am/domain';
import {
  ACQUISITION_FIELD_KEYS,
  COMPANY_RULE_MODES,
  DEAL_CREATION_MODES,
  DEAL_NAME_TOKENS,
  FIELD_TRANSFORMS,
  type HubspotMappingDocument,
  type MappingWizardStepKey,
} from '@am/hubspot';

/**
 * A field-level description of the HubSpot mapping document, per wizard step.
 *
 * The mapping has around eighty settable values across fifteen steps. Writing
 * eighty hand-rolled controls would guarantee that some of them drift out of
 * sync with the schema, so the wizard renders from this table instead: each
 * entry names the dotted path into the document, the German label and the kind
 * of control. `validateMapping` remains the authority on what is required — the
 * table only decides what is editable.
 */

export interface MappingOption {
  value: string;
  labelDe: string;
}

export type MappingFieldKind =
  | 'text'
  | 'select'
  | 'boolean'
  | 'number'
  | 'stringList'
  | 'keyValue'
  | 'objectList';

export interface MappingSubField {
  key: string;
  labelDe: string;
  kind: 'text' | 'select' | 'boolean' | 'stringList';
  options?: readonly MappingOption[];
  placeholder?: string;
}

export interface MappingFieldDescriptor {
  path: string;
  labelDe: string;
  kind: MappingFieldKind;
  helpDe?: string;
  /** An empty input becomes `null` rather than an empty string. */
  nullable?: boolean;
  placeholder?: string;
  options?: readonly MappingOption[];
  /** `objectList` only. */
  subFields?: readonly MappingSubField[];
  newRow?: Record<string, unknown>;
  /** `keyValue` only — restricts the key side to a known set. */
  keyOptions?: readonly MappingOption[];
  keyLabelDe?: string;
  valueLabelDe?: string;
}

/* -------------------------------------------------------------------------- */
/* Option sets                                                                 */
/* -------------------------------------------------------------------------- */

const SALES_EVENT_GLOSS_DE: Readonly<Record<(typeof SALES_EVENT_TYPES)[number], string>> = {
  FORM_COMPLETED: 'Formular abgeschickt',
  VQ_SCHEDULED: 'Qualifizierungstermin vereinbart',
  VQ_ATTENDED: 'Qualifizierungstermin wahrgenommen',
  VQ_NO_SHOW: 'Termin nicht wahrgenommen',
  VQ_PASSED: 'Qualifizierung bestanden',
  VQ_REJECTED: 'Qualifizierung abgelehnt',
  SALES_ACCEPTED: 'Vom Vertrieb angenommen',
  OPPORTUNITY_CREATED: 'Opportunity angelegt',
  CLOSED_WON: 'Gewonnen',
  CLOSED_LOST: 'Verloren',
  REVENUE_RECOGNIZED: 'Umsatz realisiert',
};

const VQ_STATUS_GLOSS_DE: Readonly<Record<(typeof VQ_STATUSES)[number], string>> = {
  NOT_SCHEDULED: 'Nicht terminiert',
  SCHEDULED: 'Terminiert',
  ATTENDED: 'Stattgefunden',
  NO_SHOW: 'Nicht erschienen',
  PASSED: 'Qualifiziert',
  REJECTED: 'Abgelehnt',
};

const OPERATOR_GLOSS_DE: Readonly<Record<(typeof CONDITION_OPERATORS)[number], string>> = {
  EQUALS: 'ist gleich',
  NOT_EQUALS: 'ist ungleich',
  IN: 'ist einer von',
  NOT_IN: 'ist keiner von',
  GREATER_THAN: 'größer als',
  LESS_THAN: 'kleiner als',
  IS_EMPTY: 'ist leer',
  IS_NOT_EMPTY: 'ist nicht leer',
};

const COMPANY_RULE_GLOSS_DE: Readonly<Record<(typeof COMPANY_RULE_MODES)[number], string>> = {
  NEVER: 'Nie ein Unternehmen anlegen',
  VERIFIED_CORPORATE_DOMAIN_ONLY: 'Nur bei verifizierter Firmendomain',
  ALWAYS: 'Immer anlegen (nicht empfohlen)',
};

const DEAL_MODE_GLOSS_DE: Readonly<Record<(typeof DEAL_CREATION_MODES)[number], string>> = {
  ONE_PER_OPPORTUNITY: 'Ein Deal pro Opportunity',
  ONE_PER_SUBMISSION: 'Ein Deal pro Formularabsendung',
};

export const SALES_EVENT_OPTIONS: readonly MappingOption[] = SALES_EVENT_TYPES.map((value) => ({
  value,
  labelDe: `${SALES_EVENT_GLOSS_DE[value]} (${value})`,
}));

const VQ_STATUS_OPTIONS: readonly MappingOption[] = VQ_STATUSES.map((value) => ({
  value,
  labelDe: `${VQ_STATUS_GLOSS_DE[value]} (${value})`,
}));

const OPERATOR_OPTIONS: readonly MappingOption[] = CONDITION_OPERATORS.map((value) => ({
  value,
  labelDe: OPERATOR_GLOSS_DE[value],
}));

const TRANSFORM_OPTIONS: readonly MappingOption[] = FIELD_TRANSFORMS.map((value) => ({
  value,
  labelDe: value,
}));

const ACQUISITION_KEY_OPTIONS: readonly MappingOption[] = ACQUISITION_FIELD_KEYS.map((value) => ({
  value,
  labelDe: value,
}));

const OBJECT_TYPE_OPTIONS: readonly MappingOption[] = [
  { value: 'contacts', labelDe: 'contacts' },
  { value: 'companies', labelDe: 'companies' },
  { value: 'deals', labelDe: 'deals' },
];

/* -------------------------------------------------------------------------- */
/* The table                                                                   */
/* -------------------------------------------------------------------------- */

export const MAPPING_FIELDS: Readonly<
  Record<MappingWizardStepKey, readonly MappingFieldDescriptor[]>
> = {
  objects: [
    { path: 'objects.contact', labelDe: 'Objekttyp für Kontakte', kind: 'text' },
    { path: 'objects.company', labelDe: 'Objekttyp für Unternehmen', kind: 'text' },
    { path: 'objects.deal', labelDe: 'Objekttyp für Deals', kind: 'text' },
  ],

  contact_identifier: [
    {
      path: 'contactIdentifier.property',
      labelDe: 'Identifikations-Eigenschaft',
      kind: 'text',
      helpDe: 'Interner Eigenschaftsname, nicht das Label. In einem Standardportal „email“.',
    },
    {
      path: 'contactIdentifier.normalization',
      labelDe: 'Normalisierung',
      kind: 'select',
      options: [
        { value: 'EMAIL_LOWERCASE', labelDe: 'E-Mail in Kleinbuchstaben' },
        { value: 'NONE', labelDe: 'Keine' },
      ],
    },
    {
      path: 'contactIdentifier.personIdProperty',
      labelDe: 'Eigenschaft für die A&M-Personen-ID',
      kind: 'text',
      nullable: true,
      helpDe: 'Ohne sie lässt sich ein Kontakt später nur über die E-Mail wiederfinden.',
    },
    { path: 'contactIdentifier.firstNameProperty', labelDe: 'Vorname', kind: 'text', nullable: true },
    { path: 'contactIdentifier.lastNameProperty', labelDe: 'Nachname', kind: 'text', nullable: true },
    { path: 'contactIdentifier.phoneProperty', labelDe: 'Telefon', kind: 'text', nullable: true },
    {
      path: 'contactIdentifier.leadSourceProperty',
      labelDe: 'Eigenschaft für die Lead-Quelle',
      kind: 'text',
      nullable: true,
      helpDe: 'Wird nur beim Anlegen geschrieben, damit ein späterer Kontakt die Quelle nicht überschreibt.',
    },
    {
      path: 'contactIdentifier.leadSourceValue',
      labelDe: 'Wert der Lead-Quelle',
      kind: 'text',
      nullable: true,
    },
  ],

  company_rule: [
    {
      path: 'company.mode',
      labelDe: 'Wann wird ein Unternehmen angelegt?',
      kind: 'select',
      options: COMPANY_RULE_MODES.map((value) => ({ value, labelDe: COMPANY_RULE_GLOSS_DE[value] })),
      helpDe: 'Freemail-Domains erzeugen niemals automatisch ein Unternehmen.',
    },
    { path: 'company.domainProperty', labelDe: 'Domain-Eigenschaft', kind: 'text' },
    { path: 'company.nameProperty', labelDe: 'Namens-Eigenschaft', kind: 'text' },
    {
      path: 'company.additionalFreemailDomains',
      labelDe: 'Zusätzliche Freemail-Domains',
      kind: 'stringList',
      helpDe: 'Portalspezifische Ergänzungen zur kanonischen Liste, kommagetrennt.',
    },
    {
      path: 'company.associateContactToCompany',
      labelDe: 'Kontakt mit Unternehmen verknüpfen',
      kind: 'boolean',
    },
  ],

  pipeline: [
    {
      path: 'pipeline.pipelineId',
      labelDe: 'Pipeline-ID',
      kind: 'text',
      nullable: true,
      helpDe: 'Die interne ID aus dem HubSpot-Portal des Kunden — nicht das Label.',
    },
    { path: 'pipeline.pipelineLabel', labelDe: 'Pipeline-Bezeichnung', kind: 'text', nullable: true },
    { path: 'pipeline.pipelineProperty', labelDe: 'Pipeline-Eigenschaft', kind: 'text' },
    { path: 'pipeline.stageProperty', labelDe: 'Stage-Eigenschaft', kind: 'text' },
    {
      path: 'pipeline.defaultStageId',
      labelDe: 'Start-Stage für neue Deals',
      kind: 'text',
      nullable: true,
    },
  ],

  deal_trigger: [
    {
      path: 'dealCreation.trigger',
      labelDe: 'Auslösendes Ereignis',
      kind: 'select',
      options: SALES_EVENT_OPTIONS,
      helpDe: 'Ein Deal entsteht bei diesem Ereignis — nicht bei jeder Formularabsendung.',
    },
    {
      path: 'dealCreation.mode',
      labelDe: 'Anzahl der Deals',
      kind: 'select',
      options: DEAL_CREATION_MODES.map((value) => ({ value, labelDe: DEAL_MODE_GLOSS_DE[value] })),
    },
  ],

  deal_identity: [
    {
      path: 'dealCreation.nameTemplate',
      labelDe: 'Vorlage für den Deal-Namen',
      kind: 'text',
      helpDe: `Erlaubte Platzhalter: ${DEAL_NAME_TOKENS.map((token) => `{{${token}}}`).join(', ')}`,
    },
    {
      path: 'dealCreation.opportunityIdProperty',
      labelDe: 'Eigenschaft für die A&M-Opportunity-ID',
      kind: 'text',
      nullable: true,
    },
    {
      path: 'dealCreation.submissionIdProperty',
      labelDe: 'Eigenschaft für die Submission-ID',
      kind: 'text',
      nullable: true,
    },
    {
      path: 'dealCreation.personIdProperty',
      labelDe: 'Eigenschaft für die Personen-ID am Deal',
      kind: 'text',
      nullable: true,
    },
    {
      path: 'dealCreation.closeDateProperty',
      labelDe: 'Eigenschaft für das Abschlussdatum',
      kind: 'text',
      nullable: true,
    },
    {
      path: 'dealCreation.ownerProperty',
      labelDe: 'Eigenschaft für den Deal-Owner',
      kind: 'text',
      nullable: true,
    },
  ],

  stage_events: [
    {
      path: 'stageEvents',
      labelDe: 'Stage-Regeln',
      kind: 'objectList',
      helpDe:
        'Jede Pipeline-Stage wird auf genau ein kanonisches Vertriebsereignis abgebildet. Eine terminale Stage sendet ihr Ereignis auch nach einem Re-Open nicht erneut.',
      subFields: [
        { key: 'id', labelDe: 'Regel-ID', kind: 'text', placeholder: 'stage-won' },
        { key: 'stageId', labelDe: 'Stage-ID', kind: 'text', placeholder: 'closedwon' },
        { key: 'stageLabel', labelDe: 'Stage-Bezeichnung', kind: 'text' },
        { key: 'event', labelDe: 'Ereignis', kind: 'select', options: SALES_EVENT_OPTIONS },
        { key: 'terminal', labelDe: 'Terminal', kind: 'boolean' },
      ],
      newRow: {
        id: '',
        objectType: 'deals',
        pipelineId: null,
        stageId: '',
        stageLabel: null,
        event: 'VQ_SCHEDULED',
        terminal: true,
        occurredAtProperty: null,
      },
    },
  ],

  property_value_events: [
    {
      path: 'propertyValueEvents',
      labelDe: 'Wertregeln',
      kind: 'objectList',
      helpDe:
        'Für Ereignisse, die nicht an einer Stage hängen — etwa eine No-Show-Kennzeichnung auf dem Kontakt.',
      subFields: [
        { key: 'id', labelDe: 'Regel-ID', kind: 'text', placeholder: 'vq-no-show' },
        { key: 'objectType', labelDe: 'Objekttyp', kind: 'select', options: OBJECT_TYPE_OPTIONS },
        { key: 'property', labelDe: 'Eigenschaft', kind: 'text' },
        { key: 'operator', labelDe: 'Vergleich', kind: 'select', options: OPERATOR_OPTIONS },
        { key: 'values', labelDe: 'Vergleichswerte', kind: 'stringList' },
        { key: 'event', labelDe: 'Ereignis', kind: 'select', options: SALES_EVENT_OPTIONS },
        { key: 'once', labelDe: 'Nur einmal', kind: 'boolean' },
      ],
      newRow: {
        id: '',
        objectType: 'contacts',
        property: '',
        operator: 'EQUALS',
        values: [],
        event: 'VQ_NO_SHOW',
        once: false,
        occurredAtProperty: null,
      },
    },
  ],

  revenue: [
    {
      path: 'revenue.amountProperty',
      labelDe: 'Eigenschaft für den Betrag',
      kind: 'text',
      nullable: true,
    },
    {
      path: 'revenue.currencyProperty',
      labelDe: 'Eigenschaft für die Währung',
      kind: 'text',
      nullable: true,
      helpDe: 'Fehlt sie, wird durchgängig die Ersatzwährung angenommen.',
    },
    { path: 'revenue.fallbackCurrency', labelDe: 'Ersatzwährung', kind: 'text' },
    {
      path: 'revenue.amountUnit',
      labelDe: 'Einheit des Betrags',
      kind: 'select',
      options: [
        { value: 'MAJOR', labelDe: 'Hauptwährungseinheit (z. B. Euro)' },
        { value: 'MINOR', labelDe: 'Kleinste Einheit (z. B. Cent)' },
      ],
    },
    {
      path: 'revenue.recognizedStageIds',
      labelDe: 'Stages, ab denen Umsatz realisiert ist',
      kind: 'stringList',
    },
    {
      path: 'revenue.recognizedAtProperty',
      labelDe: 'Eigenschaft für den Realisierungszeitpunkt',
      kind: 'text',
      nullable: true,
    },
  ],

  lost_rules: [
    { path: 'lostRules.lostStageIds', labelDe: 'Stages „verloren“', kind: 'stringList' },
    {
      path: 'lostRules.lostReasonProperty',
      labelDe: 'Eigenschaft für den Verlustgrund',
      kind: 'text',
      nullable: true,
    },
    {
      path: 'lostRules.disqualifiedReasonValues',
      labelDe: 'Gründe, die „disqualifiziert“ bedeuten',
      kind: 'stringList',
      helpDe: 'Abgrenzung zu „spät verloren“ — beides zählt unterschiedlich in der Auswertung.',
    },
    {
      path: 'lostRules.noShowProperty',
      labelDe: 'Eigenschaft für No-Show',
      kind: 'text',
      nullable: true,
    },
    { path: 'lostRules.noShowValues', labelDe: 'Werte, die No-Show bedeuten', kind: 'stringList' },
    { path: 'lostRules.noShowStageIds', labelDe: 'Stages, die No-Show bedeuten', kind: 'stringList' },
  ],

  vq: [
    {
      path: 'vq.statusProperty',
      labelDe: 'Eigenschaft für den VQ-Status',
      kind: 'text',
      nullable: true,
    },
    {
      path: 'vq.statusValueMap',
      labelDe: 'Wertzuordnung Status',
      kind: 'keyValue',
      keyLabelDe: 'Wert im Portal',
      valueLabelDe: 'Kanonischer Status',
      options: VQ_STATUS_OPTIONS,
      helpDe: 'Links der Wert, wie er im Portal steht; rechts der kanonische A&M-Status.',
    },
    { path: 'vq.scoreProperty', labelDe: 'Eigenschaft für den Score', kind: 'text', nullable: true },
    { path: 'vq.scoreMin', labelDe: 'Score-Minimum', kind: 'number' },
    { path: 'vq.scoreMax', labelDe: 'Score-Maximum', kind: 'number' },
    {
      path: 'vq.reasonCodeProperty',
      labelDe: 'Eigenschaft für Ablehnungsgründe',
      kind: 'text',
      nullable: true,
    },
    { path: 'vq.reasonCodeSeparator', labelDe: 'Trennzeichen der Gründe', kind: 'text' },
    {
      path: 'vq.scheduledAtProperty',
      labelDe: 'Eigenschaft für den Termin-Zeitpunkt',
      kind: 'text',
      nullable: true,
    },
  ],

  acquisition_fields: [
    {
      path: 'acquisition.contactProperties',
      labelDe: 'Akquisitionsfelder am Kontakt',
      kind: 'keyValue',
      keyLabelDe: 'Akquisitionsfeld',
      valueLabelDe: 'HubSpot-Eigenschaft',
      keyOptions: ACQUISITION_KEY_OPTIONS,
    },
    {
      path: 'acquisition.dealProperties',
      labelDe: 'Akquisitionsfelder am Deal',
      kind: 'keyValue',
      keyLabelDe: 'Akquisitionsfeld',
      valueLabelDe: 'HubSpot-Eigenschaft',
      keyOptions: ACQUISITION_KEY_OPTIONS,
    },
    {
      path: 'acquisition.writeOnce',
      labelDe: 'Nur einmal schreiben',
      kind: 'boolean',
      helpDe:
        'Die Akquisitionsdaten werden beim ersten Kontakt gebunden. Ein späterer Touch darf sie nie überschreiben.',
    },
  ],

  form_fields: [
    {
      path: 'formFieldMappings',
      labelDe: 'Formularfelder',
      kind: 'objectList',
      helpDe:
        'Mindestens ein Feld muss in die Identifikations-Eigenschaft schreiben, sonst lässt sich der Kontakt nicht auflösen.',
      subFields: [
        { key: 'fieldKey', labelDe: 'Feld im Formular', kind: 'text', placeholder: 'email' },
        { key: 'objectType', labelDe: 'Objekttyp', kind: 'select', options: OBJECT_TYPE_OPTIONS },
        { key: 'property', labelDe: 'HubSpot-Eigenschaft', kind: 'text' },
        { key: 'transform', labelDe: 'Transformation', kind: 'select', options: TRANSFORM_OPTIONS },
        { key: 'writeOnce', labelDe: 'Nur einmal', kind: 'boolean' },
      ],
      newRow: {
        fieldKey: '',
        objectType: 'contacts',
        property: '',
        transform: 'NONE',
        writeOnce: false,
      },
    },
  ],

  test_lead: [
    {
      path: 'testLead.markerProperty',
      labelDe: 'Eigenschaft zur Kennzeichnung von Testdaten',
      kind: 'text',
      nullable: true,
    },
    { path: 'testLead.markerValue', labelDe: 'Kennzeichnungswert', kind: 'text' },
    { path: 'testLead.emailLocalPart', labelDe: 'Lokaler Teil der Test-Adresse', kind: 'text' },
    {
      path: 'testLead.emailDomain',
      labelDe: 'E-Mail-Domain für den Test-Lead',
      kind: 'text',
      nullable: true,
      helpDe: 'Muss vom Betreiber kommen. Ohne sie kann der Test-Lead nicht live ausgeführt werden.',
    },
    { path: 'testLead.firstName', labelDe: 'Vorname im Test', kind: 'text' },
    { path: 'testLead.lastName', labelDe: 'Nachname im Test', kind: 'text' },
    {
      path: 'testLead.cleanup',
      labelDe: 'Nachbereitung',
      kind: 'select',
      options: [
        { value: 'MARK_ONLY', labelDe: 'Nur kennzeichnen' },
        { value: 'ARCHIVE', labelDe: 'Kennzeichnen und manuell archivieren' },
        { value: 'NONE', labelDe: 'Nichts tun' },
      ],
    },
  ],

  webhooks: [
    {
      path: 'webhook.subscribedObjectTypes',
      labelDe: 'Abonnierte Objekttypen',
      kind: 'stringList',
    },
    {
      path: 'webhook.subscribedProperties',
      labelDe: 'Abonnierte Eigenschaften',
      kind: 'stringList',
    },
    {
      path: 'webhook.toleranceSeconds',
      labelDe: 'Zeittoleranz der Signaturprüfung (Sekunden)',
      kind: 'number',
    },
  ],
};

/* -------------------------------------------------------------------------- */
/* Path access                                                                 */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function getAtPath(document: unknown, path: string): unknown {
  let current: unknown = document;
  for (const segment of path.split('.')) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * Returns a copy of the document with `path` replaced. Structural sharing along
 * the path only — nothing outside the path is cloned, and nothing is mutated,
 * so React state updates stay predictable.
 */
export function setAtPath(
  document: HubspotMappingDocument,
  path: string,
  value: unknown,
): HubspotMappingDocument {
  const segments = path.split('.');

  const write = (node: unknown, index: number): unknown => {
    const key = segments[index];
    const base = isRecord(node) ? { ...node } : {};
    base[key] = index === segments.length - 1 ? value : write(base[key], index + 1);
    return base;
  };

  return write(document, 0) as HubspotMappingDocument;
}

/* -------------------------------------------------------------------------- */
/* Value coercion                                                              */
/* -------------------------------------------------------------------------- */

export function readText(document: unknown, path: string): string {
  const value = getAtPath(document, path);
  if (value === null || value === undefined) return '';
  return String(value);
}

export function readNumber(document: unknown, path: string): number {
  const value = getAtPath(document, path);
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function readBoolean(document: unknown, path: string): boolean {
  return getAtPath(document, path) === true;
}

export function readStringList(document: unknown, path: string): string[] {
  const value = getAtPath(document, path);
  return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
}

export function readRecord(document: unknown, path: string): Record<string, string> {
  const value = getAtPath(document, path);
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]));
}

export function readRows(document: unknown, path: string): Record<string, unknown>[] {
  const value = getAtPath(document, path);
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** Splits a comma-separated input, dropping blanks so a trailing comma is harmless. */
export function parseStringList(input: string): string[] {
  return input
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function formatStringList(values: readonly string[]): string {
  return values.join(', ');
}
