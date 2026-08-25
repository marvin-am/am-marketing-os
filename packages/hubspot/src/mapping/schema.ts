import { z } from 'zod';
import {
  SALES_EVENT_TYPES,
  conditionOperatorSchema,
  currencySchema,
  isoTimestampSchema,
  salesEventTypeSchema,
  specKeySchema,
  uuidSchema,
  vqStatusSchema,
  type SalesEventType,
} from '@am/domain';

/**
 * The versioned HubSpot mapping document.
 *
 * The customer's real property names, VQ definition, pipeline and deal stages
 * are not known at build time and are supplied through the 15-step wizard. This
 * module therefore contains *no* customer-specific value: everything below is
 * either a canonical A&M concept or a HubSpot platform constant. The document is
 * immutable once published — a change produces a new `version`.
 */

/* -------------------------------------------------------------------------- */
/* HubSpot platform constants                                                  */
/* -------------------------------------------------------------------------- */

/**
 * HubSpot's own out-of-the-box internal names. They are used only as *defaults*
 * that the wizard overwrites with whatever the customer's portal actually uses —
 * never as an assumption about a specific portal.
 */
export const HUBSPOT_STANDARD_PROPERTIES = {
  contactEmail: 'email',
  contactFirstName: 'firstname',
  contactLastName: 'lastname',
  contactPhone: 'phone',
  contactLifecycleStage: 'lifecyclestage',
  companyDomain: 'domain',
  companyName: 'name',
  dealName: 'dealname',
  dealStage: 'dealstage',
  dealPipeline: 'pipeline',
  dealAmount: 'amount',
  dealCurrency: 'deal_currency_code',
  dealCloseDate: 'closedate',
  lastModified: 'hs_lastmodifieddate',
  objectId: 'hs_object_id',
} as const;

export const HUBSPOT_CORE_OBJECT_TYPES = {
  contacts: 'contacts',
  companies: 'companies',
  deals: 'deals',
} as const;

/** Object type ids are free-form so custom objects remain mappable. */
export const hubspotObjectTypeSchema = z.string().min(1).max(64);

/** A HubSpot internal property name. Never a label — labels are renameable. */
export const hubspotPropertySchema = z.string().min(1).max(120);
const nullableProperty = hubspotPropertySchema.nullable().default(null);

/* -------------------------------------------------------------------------- */
/* Wizard steps                                                                */
/* -------------------------------------------------------------------------- */

export const MAPPING_WIZARD_STEP_KEYS = [
  'objects',
  'contact_identifier',
  'company_rule',
  'pipeline',
  'deal_trigger',
  'deal_identity',
  'stage_events',
  'property_value_events',
  'revenue',
  'lost_rules',
  'vq',
  'acquisition_fields',
  'form_fields',
  'test_lead',
  'webhooks',
] as const;
export const mappingWizardStepKeySchema = z.enum(MAPPING_WIZARD_STEP_KEYS);
export type MappingWizardStepKey = z.infer<typeof mappingWizardStepKeySchema>;

export interface MappingWizardStep {
  key: MappingWizardStepKey;
  order: number;
  labelDe: string;
  descriptionDe: string;
  /** Whether an incomplete step blocks the live launch. */
  requiredForLaunch: boolean;
}

export const MAPPING_WIZARD_STEPS: readonly MappingWizardStep[] = [
  {
    key: 'objects',
    order: 1,
    labelDe: 'Objekttypen',
    descriptionDe: 'Welche HubSpot-Objekte werden für Kontakte, Unternehmen und Deals genutzt?',
    requiredForLaunch: true,
  },
  {
    key: 'contact_identifier',
    order: 2,
    labelDe: 'Kontakt-Identifikator',
    descriptionDe: 'Über welche Eigenschaft wird ein Kontakt eindeutig identifiziert?',
    requiredForLaunch: true,
  },
  {
    key: 'company_rule',
    order: 3,
    labelDe: 'Unternehmensregel',
    descriptionDe:
      'Wann wird ein Unternehmen angelegt? Freemail-Domains erzeugen niemals automatisch ein Unternehmen.',
    requiredForLaunch: true,
  },
  {
    key: 'pipeline',
    order: 4,
    labelDe: 'Pipeline',
    descriptionDe: 'Welche Deal-Pipeline wird bespielt?',
    requiredForLaunch: true,
  },
  {
    key: 'deal_trigger',
    order: 5,
    labelDe: 'Deal-Auslöser',
    descriptionDe: 'Bei welchem Ereignis entsteht ein Deal? Nicht pro Formularabsendung.',
    requiredForLaunch: true,
  },
  {
    key: 'deal_identity',
    order: 6,
    labelDe: 'Deal-Identität',
    descriptionDe: 'Wohin schreiben wir Opportunity-ID, Submission-ID und den Deal-Namen?',
    requiredForLaunch: true,
  },
  {
    key: 'stage_events',
    order: 7,
    labelDe: 'Stages → Ereignisse',
    descriptionDe: 'Zuordnung der Pipeline-Stages auf die kanonischen Vertriebsereignisse.',
    requiredForLaunch: true,
  },
  {
    key: 'property_value_events',
    order: 8,
    labelDe: 'Eigenschaftswerte → Ereignisse',
    descriptionDe: 'Zuordnung einzelner Eigenschaftswerte auf kanonische Vertriebsereignisse.',
    requiredForLaunch: false,
  },
  {
    key: 'revenue',
    order: 9,
    labelDe: 'Umsatz',
    descriptionDe: 'Welche Eigenschaft trägt den Betrag, welche die Währung?',
    requiredForLaunch: true,
  },
  {
    key: 'lost_rules',
    order: 10,
    labelDe: 'Verloren / No-Show',
    descriptionDe: 'Regeln für verlorene Deals und nicht wahrgenommene Termine.',
    requiredForLaunch: true,
  },
  {
    key: 'vq',
    order: 11,
    labelDe: 'VQ-Definition',
    descriptionDe: 'Wie werden Status, Score und Ablehnungsgründe der Qualifizierung abgebildet?',
    requiredForLaunch: true,
  },
  {
    key: 'acquisition_fields',
    order: 12,
    labelDe: 'Akquisitionsfelder',
    descriptionDe: 'Wohin schreiben wir Kampagnen-, Angle-, Offer-, Creative- und UTM-Kennungen?',
    requiredForLaunch: true,
  },
  {
    key: 'form_fields',
    order: 13,
    labelDe: 'Formularfelder',
    descriptionDe: 'Zuordnung der Formularfelder auf HubSpot-Kontakteigenschaften.',
    requiredForLaunch: true,
  },
  {
    key: 'test_lead',
    order: 14,
    labelDe: 'Test-Lead',
    descriptionDe: 'Kennzeichnung und Bereinigung des End-to-End-Test-Leads.',
    requiredForLaunch: false,
  },
  {
    key: 'webhooks',
    order: 15,
    labelDe: 'Webhooks',
    descriptionDe: 'Welche Objekt- und Eigenschaftsänderungen abonniert werden.',
    requiredForLaunch: false,
  },
];

/* -------------------------------------------------------------------------- */
/* Rule fragments                                                              */
/* -------------------------------------------------------------------------- */

export const COMPANY_RULE_MODES = [
  'NEVER',
  'VERIFIED_CORPORATE_DOMAIN_ONLY',
  'ALWAYS',
] as const;
export const companyRuleModeSchema = z.enum(COMPANY_RULE_MODES);
export type CompanyRuleMode = z.infer<typeof companyRuleModeSchema>;

export const DEAL_CREATION_MODES = ['ONE_PER_OPPORTUNITY', 'ONE_PER_SUBMISSION'] as const;
export const dealCreationModeSchema = z.enum(DEAL_CREATION_MODES);

export const FIELD_TRANSFORMS = [
  'NONE',
  'TRIM',
  'LOWERCASE',
  'UPPERCASE',
  'EMAIL_NORMALIZE',
  'PHONE_E164',
  'JOIN_SEMICOLON',
  'BOOLEAN_YES_NO',
  'BOOLEAN_TRUE_FALSE',
  'NUMBER',
  'ISO_DATE',
] as const;
export const fieldTransformSchema = z.enum(FIELD_TRANSFORMS);
export type FieldTransform = z.infer<typeof fieldTransformSchema>;

/**
 * Canonical acquisition slots we are able to write into the CRM. The wizard
 * decides *which* HubSpot property each slot lands in; the slot names themselves
 * mirror `trackingContextSchema` + `marketingParamsSchema` from `@am/domain`.
 */
export const ACQUISITION_FIELD_KEYS = [
  'campaign_id',
  'campaign_version_id',
  'angle_id',
  'angle_version_id',
  'offer_id',
  'offer_version_id',
  'creative_id',
  'creative_version_id',
  'funnel_id',
  'funnel_version_id',
  'form_id',
  'form_version_id',
  'experiment_id',
  'experiment_arm_id',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'fbclid',
  'fbc',
  'fbp',
  'meta_campaign_id',
  'meta_adset_id',
  'meta_ad_id',
  'landing_url',
  'referrer',
  'channel',
  'attribution_confidence',
  'submission_id',
  'attribution_snapshot_id',
] as const;
export const acquisitionFieldKeySchema = z.enum(ACQUISITION_FIELD_KEYS);
export type AcquisitionFieldKey = z.infer<typeof acquisitionFieldKeySchema>;

/** Slots that must land somewhere before a campaign may go live. */
export const REQUIRED_ACQUISITION_FIELD_KEYS: readonly AcquisitionFieldKey[] = [
  'campaign_id',
  'campaign_version_id',
  'funnel_version_id',
  'submission_id',
];

/** Canonical events that must be reachable from the mapping before go-live. */
export const REQUIRED_MAPPED_EVENTS: readonly SalesEventType[] = [
  'VQ_SCHEDULED',
  'VQ_PASSED',
  'VQ_REJECTED',
  'CLOSED_WON',
  'CLOSED_LOST',
];

/** Events we emit ourselves and never expect to find in the customer's CRM. */
export const INTERNALLY_EMITTED_EVENTS: readonly SalesEventType[] = [
  'FORM_COMPLETED',
  'OPPORTUNITY_CREATED',
];

/** Tokens the wizard allows inside a deal-name template. */
export const DEAL_NAME_TOKENS = [
  'firstName',
  'lastName',
  'fullName',
  'email',
  'emailDomain',
  'company',
  'campaign',
  'offer',
  'submissionId',
  'opportunityId',
  'date',
] as const;
export type DealNameToken = (typeof DEAL_NAME_TOKENS)[number];

/* -------------------------------------------------------------------------- */
/* Document sections                                                           */
/* -------------------------------------------------------------------------- */

export const stageEventRuleSchema = z.object({
  /** Stable rule id so an emitted event can name the rule that produced it. */
  id: z.string().min(1).max(64),
  objectType: hubspotObjectTypeSchema.default(HUBSPOT_CORE_OBJECT_TYPES.deals),
  pipelineId: z.string().max(120).nullable().default(null),
  /** The customer's internal stage id — never a label. */
  stageId: z.string().min(1).max(120),
  stageLabel: z.string().max(200).nullable().default(null),
  event: salesEventTypeSchema,
  /** A terminal stage never re-emits its event, even after a re-open. */
  terminal: z.boolean().default(false),
  /** Property carrying the business time of the transition, if the CRM has one. */
  occurredAtProperty: nullableProperty,
});
export type StageEventRule = z.infer<typeof stageEventRuleSchema>;

export const propertyValueEventRuleSchema = z.object({
  id: z.string().min(1).max(64),
  objectType: hubspotObjectTypeSchema.default(HUBSPOT_CORE_OBJECT_TYPES.contacts),
  property: hubspotPropertySchema,
  operator: conditionOperatorSchema.default('EQUALS'),
  values: z.array(z.string().max(200)).max(50).default([]),
  event: salesEventTypeSchema,
  /** Emit at most once per object, even if the condition re-enters. */
  once: z.boolean().default(false),
  occurredAtProperty: nullableProperty,
});
export type PropertyValueEventRule = z.infer<typeof propertyValueEventRuleSchema>;

export const formFieldMappingSchema = z.object({
  /** Stable form field key from the funnel spec. */
  fieldKey: specKeySchema,
  objectType: hubspotObjectTypeSchema.default(HUBSPOT_CORE_OBJECT_TYPES.contacts),
  property: hubspotPropertySchema,
  transform: fieldTransformSchema.default('NONE'),
  /** Never overwrite a non-empty CRM value with a later submission. */
  writeOnce: z.boolean().default(false),
});
export type FormFieldMapping = z.infer<typeof formFieldMappingSchema>;

export const mappingObjectsSchema = z.object({
  contact: hubspotObjectTypeSchema.default(HUBSPOT_CORE_OBJECT_TYPES.contacts),
  company: hubspotObjectTypeSchema.default(HUBSPOT_CORE_OBJECT_TYPES.companies),
  deal: hubspotObjectTypeSchema.default(HUBSPOT_CORE_OBJECT_TYPES.deals),
});

export const contactIdentifierSchema = z.object({
  /** Property HubSpot resolves the contact by (`email` in a default portal). */
  property: hubspotPropertySchema.default(HUBSPOT_STANDARD_PROPERTIES.contactEmail),
  normalization: z.enum(['EMAIL_LOWERCASE', 'NONE']).default('EMAIL_LOWERCASE'),
  /** Where our stable `am_person_id` is stored. */
  personIdProperty: nullableProperty,
  firstNameProperty: nullableProperty,
  lastNameProperty: nullableProperty,
  phoneProperty: nullableProperty,
  /** Written on create only, so a later touch cannot rewrite the source. */
  leadSourceProperty: nullableProperty,
  leadSourceValue: z.string().max(120).nullable().default(null),
});

export const companyRuleSchema = z.object({
  mode: companyRuleModeSchema.default('VERIFIED_CORPORATE_DOMAIN_ONLY'),
  domainProperty: hubspotPropertySchema.default(HUBSPOT_STANDARD_PROPERTIES.companyDomain),
  nameProperty: hubspotPropertySchema.default(HUBSPOT_STANDARD_PROPERTIES.companyName),
  /** Portal-specific freemail domains on top of the canonical list. */
  additionalFreemailDomains: z.array(z.string().max(120)).max(200).default([]),
  associateContactToCompany: z.boolean().default(true),
  associationCategory: z.enum(['HUBSPOT_DEFINED', 'USER_DEFINED']).default('HUBSPOT_DEFINED'),
  /** Null means "let HubSpot apply its default label for this pair". */
  contactToCompanyAssociationTypeId: z.number().int().min(0).nullable().default(null),
});

export const pipelineMappingSchema = z.object({
  /** Internal pipeline id. Unknown until the customer's portal is connected. */
  pipelineId: z.string().max(120).nullable().default(null),
  pipelineLabel: z.string().max(200).nullable().default(null),
  pipelineProperty: hubspotPropertySchema.default(HUBSPOT_STANDARD_PROPERTIES.dealPipeline),
  stageProperty: hubspotPropertySchema.default(HUBSPOT_STANDARD_PROPERTIES.dealStage),
  /** Stage a newly created deal enters. */
  defaultStageId: z.string().max(120).nullable().default(null),
});

export const dealCreationSchema = z.object({
  /** Which canonical event brings an opportunity into existence. */
  trigger: salesEventTypeSchema.default('VQ_SCHEDULED'),
  mode: dealCreationModeSchema.default('ONE_PER_OPPORTUNITY'),
  nameTemplate: z.string().min(1).max(200).default('{{fullName}} – {{campaign}}'),
  opportunityIdProperty: nullableProperty,
  submissionIdProperty: nullableProperty,
  personIdProperty: nullableProperty,
  closeDateProperty: nullableProperty,
  ownerProperty: nullableProperty,
  associationCategory: z.enum(['HUBSPOT_DEFINED', 'USER_DEFINED']).default('HUBSPOT_DEFINED'),
  contactToDealAssociationTypeId: z.number().int().min(0).nullable().default(null),
  companyToDealAssociationTypeId: z.number().int().min(0).nullable().default(null),
});

export const revenueMappingSchema = z.object({
  amountProperty: nullableProperty,
  currencyProperty: nullableProperty,
  fallbackCurrency: currencySchema.default('EUR'),
  /** HubSpot deal amounts are major units by default. */
  amountUnit: z.enum(['MAJOR', 'MINOR']).default('MAJOR'),
  /** Stages at which revenue counts as recognised (not merely booked). */
  recognizedStageIds: z.array(z.string().max(120)).max(50).default([]),
  recognizedAtProperty: nullableProperty,
});

export const lostRulesSchema = z.object({
  lostStageIds: z.array(z.string().max(120)).max(50).default([]),
  lostReasonProperty: nullableProperty,
  /** Reason values that mean "disqualified", not "lost late". */
  disqualifiedReasonValues: z.array(z.string().max(200)).max(50).default([]),
  noShowProperty: nullableProperty,
  noShowValues: z.array(z.string().max(200)).max(50).default([]),
  noShowStageIds: z.array(z.string().max(120)).max(50).default([]),
});

export const vqMappingSchema = z.object({
  statusProperty: nullableProperty,
  /** Customer value → canonical VQ status. */
  statusValueMap: z.record(z.string().min(1).max(200), vqStatusSchema).default({}),
  scoreProperty: nullableProperty,
  scoreMin: z.number().default(0),
  scoreMax: z.number().default(100),
  reasonCodeProperty: nullableProperty,
  reasonCodeSeparator: z.string().min(1).max(4).default(';'),
  /** Frozen with the mapping version so a historical decision stays auditable. */
  modelVersion: z.string().min(1).max(40).nullable().default(null),
  scheduledAtProperty: nullableProperty,
});

export const acquisitionMappingSchema = z.object({
  /** Acquisition slot → contact property. Keys are `AcquisitionFieldKey`s. */
  contactProperties: z.record(z.string().min(1).max(64), hubspotPropertySchema).default({}),
  dealProperties: z.record(z.string().min(1).max(64), hubspotPropertySchema).default({}),
  /**
   * The acquisition snapshot is bound once. A later touch must never rewrite it
   * (spec §22) — enforced by `preserveAcquisition` in `sync.ts`.
   */
  writeOnce: z.boolean().default(true),
});

export const testLeadMappingSchema = z.object({
  markerProperty: nullableProperty,
  markerValue: z.string().min(1).max(120).default('AM_TEST_LEAD'),
  /** Local part of the probe address; the domain must be supplied by the operator. */
  emailLocalPart: z.string().min(1).max(64).default('am-marketing-os-test'),
  emailDomain: z.string().max(190).nullable().default(null),
  firstName: z.string().max(60).default('AM'),
  lastName: z.string().max(60).default('Testlead'),
  cleanup: z.enum(['ARCHIVE', 'MARK_ONLY', 'NONE']).default('MARK_ONLY'),
});

export const webhookMappingSchema = z.object({
  subscribedObjectTypes: z.array(hubspotObjectTypeSchema).max(20).default([]),
  subscribedProperties: z.array(hubspotPropertySchema).max(200).default([]),
  signatureVersion: z.literal('v3').default('v3'),
  toleranceSeconds: z.number().int().min(30).max(900).default(300),
});

/* -------------------------------------------------------------------------- */
/* The document                                                                */
/* -------------------------------------------------------------------------- */

export const MAPPING_STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const;
export const mappingStatusSchema = z.enum(MAPPING_STATUSES);
export type MappingStatus = z.infer<typeof mappingStatusSchema>;

export const mappingDocumentSchema = z.object({
  id: uuidSchema,
  version: z.number().int().min(1),
  status: mappingStatusSchema.default('DRAFT'),
  /** Set exactly when `status === 'PUBLISHED'`. */
  publishedAt: isoTimestampSchema.nullable().default(null),
  publishedBy: uuidSchema.nullable().default(null),
  createdAt: isoTimestampSchema,
  createdBy: uuidSchema.nullable().default(null),
  /** Where the document came from — a fixture is never mistaken for the real one. */
  source: z.enum(['FIXTURE', 'WIZARD', 'IMPORTED']).default('WIZARD'),
  portalId: z.string().max(64).nullable().default(null),
  notesDe: z.string().max(2000).nullable().default(null),

  objects: mappingObjectsSchema.prefault({}),
  contactIdentifier: contactIdentifierSchema.prefault({}),
  company: companyRuleSchema.prefault({}),
  pipeline: pipelineMappingSchema.prefault({}),
  dealCreation: dealCreationSchema.prefault({}),
  stageEvents: z.array(stageEventRuleSchema).max(200).default([]),
  propertyValueEvents: z.array(propertyValueEventRuleSchema).max(200).default([]),
  revenue: revenueMappingSchema.prefault({}),
  lostRules: lostRulesSchema.prefault({}),
  vq: vqMappingSchema.prefault({}),
  acquisition: acquisitionMappingSchema.prefault({}),
  formFieldMappings: z.array(formFieldMappingSchema).max(300).default([]),
  testLead: testLeadMappingSchema.prefault({}),
  webhook: webhookMappingSchema.prefault({}),
});
export type HubspotMappingDocument = z.infer<typeof mappingDocumentSchema>;
export type HubspotMappingDocumentInput = z.input<typeof mappingDocumentSchema>;

/** Parses and fills defaults. Throws a German `DomainError` on invalid input. */
export function parseMappingDocument(input: unknown): HubspotMappingDocument {
  return mappingDocumentSchema.parse(input);
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

export const MAPPING_ISSUE_CODES = [
  'SCHEMA_INVALID',
  'MISSING_REQUIRED',
  'DUPLICATE_RULE',
  'UNKNOWN_ACQUISITION_SLOT',
  'UNMAPPED_EVENT',
  'UNKNOWN_TEMPLATE_TOKEN',
  'INCONSISTENT_PIPELINE',
  'FREEMAIL_COMPANY_RISK',
  'NO_IDENTIFIER_FIELD',
  'UNREACHABLE_TRIGGER',
] as const;
export type MappingIssueCode = (typeof MAPPING_ISSUE_CODES)[number];

export interface MappingIssue {
  step: MappingWizardStepKey;
  severity: 'ERROR' | 'WARNING';
  code: MappingIssueCode;
  /** Dotted path into the document, for deep-linking the wizard step. */
  path: string;
  messageDe: string;
  /** `PUBLISH` blocks saving the version; `LAUNCH` only blocks going live. */
  blocking: 'PUBLISH' | 'LAUNCH' | 'NONE';
}

export interface MappingValidationResult {
  ok: boolean;
  issues: MappingIssue[];
  errors: MappingIssue[];
  warnings: MappingIssue[];
  /** Wizard steps that still need attention, in wizard order. */
  incompleteStepsDe: string[];
}

function issue(
  step: MappingWizardStepKey,
  severity: MappingIssue['severity'],
  code: MappingIssueCode,
  path: string,
  messageDe: string,
  blocking: MappingIssue['blocking'],
): MappingIssue {
  return { step, severity, code, path, messageDe, blocking };
}

/**
 * Validates a mapping document and reports every problem in German.
 *
 * Accepts unknown input so the wizard can validate a half-filled draft: a schema
 * violation is reported as an issue rather than thrown.
 */
export function validateMapping(input: unknown): MappingValidationResult {
  const parsed = mappingDocumentSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) =>
      issue(
        'objects',
        'ERROR',
        'SCHEMA_INVALID',
        i.path.join('.') || '$',
        `Ungültiges Mapping bei „${i.path.join('.') || 'Dokument'}“: ${i.message}`,
        'PUBLISH',
      ),
    );
    return finalize(issues);
  }

  const m = parsed.data;
  const issues: MappingIssue[] = [];

  /* --- contact identifier ------------------------------------------------ */
  if (m.contactIdentifier.property.trim().length === 0) {
    issues.push(
      issue(
        'contact_identifier',
        'ERROR',
        'MISSING_REQUIRED',
        'contactIdentifier.property',
        'Es ist keine Eigenschaft zur eindeutigen Identifikation des Kontakts hinterlegt.',
        'PUBLISH',
      ),
    );
  }
  if (!m.contactIdentifier.personIdProperty) {
    issues.push(
      issue(
        'contact_identifier',
        'WARNING',
        'MISSING_REQUIRED',
        'contactIdentifier.personIdProperty',
        'Ohne Eigenschaft für die A&M-Personen-ID lässt sich ein Kontakt später nur über die E-Mail wiederfinden.',
        'NONE',
      ),
    );
  }

  /* --- company rule ------------------------------------------------------ */
  if (m.company.mode === 'ALWAYS') {
    issues.push(
      issue(
        'company_rule',
        'WARNING',
        'FREEMAIL_COMPANY_RISK',
        'company.mode',
        'Die Regel „immer anlegen“ erzeugt auch für Freemail-Adressen Unternehmen. Empfohlen ist „nur bei verifizierter Firmendomain“.',
        'NONE',
      ),
    );
  }

  /* --- pipeline ---------------------------------------------------------- */
  if (!m.pipeline.pipelineId) {
    issues.push(
      issue(
        'pipeline',
        'ERROR',
        'MISSING_REQUIRED',
        'pipeline.pipelineId',
        'Es ist keine Deal-Pipeline ausgewählt. Die Pipeline-ID stammt aus dem HubSpot-Portal des Kunden.',
        'LAUNCH',
      ),
    );
  }
  if (!m.pipeline.defaultStageId) {
    issues.push(
      issue(
        'pipeline',
        'ERROR',
        'MISSING_REQUIRED',
        'pipeline.defaultStageId',
        'Es ist keine Start-Stage für neu angelegte Deals hinterlegt.',
        'LAUNCH',
      ),
    );
  }

  /* --- deal trigger + identity ------------------------------------------ */
  const mappedEvents = new Set<SalesEventType>([
    ...m.stageEvents.map((r) => r.event),
    ...m.propertyValueEvents.map((r) => r.event),
    ...INTERNALLY_EMITTED_EVENTS,
  ]);
  if (!mappedEvents.has(m.dealCreation.trigger)) {
    issues.push(
      issue(
        'deal_trigger',
        'ERROR',
        'UNREACHABLE_TRIGGER',
        'dealCreation.trigger',
        `Der Deal-Auslöser „${m.dealCreation.trigger}“ ist über keine Stage- oder Wertregel erreichbar.`,
        'LAUNCH',
      ),
    );
  }
  if (!m.dealCreation.opportunityIdProperty) {
    issues.push(
      issue(
        'deal_identity',
        'ERROR',
        'MISSING_REQUIRED',
        'dealCreation.opportunityIdProperty',
        'Ohne Eigenschaft für die A&M-Opportunity-ID kann ein Deal beim erneuten Sync nicht wiedererkannt werden.',
        'LAUNCH',
      ),
    );
  }
  for (const token of m.dealCreation.nameTemplate.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) {
    const name = token[1] as DealNameToken;
    if (!DEAL_NAME_TOKENS.includes(name)) {
      issues.push(
        issue(
          'deal_identity',
          'WARNING',
          'UNKNOWN_TEMPLATE_TOKEN',
          'dealCreation.nameTemplate',
          `Der Platzhalter „{{${name}}}“ im Deal-Namen ist unbekannt und bleibt leer.`,
          'NONE',
        ),
      );
    }
  }

  /* --- stage rules ------------------------------------------------------- */
  const ruleIds = new Set<string>();
  const stageKeys = new Set<string>();
  for (const rule of m.stageEvents) {
    if (ruleIds.has(rule.id)) {
      issues.push(
        issue(
          'stage_events',
          'ERROR',
          'DUPLICATE_RULE',
          `stageEvents.${rule.id}`,
          `Die Regel-ID „${rule.id}“ ist mehrfach vergeben.`,
          'PUBLISH',
        ),
      );
    }
    ruleIds.add(rule.id);

    const key = `${rule.objectType}|${rule.pipelineId ?? '*'}|${rule.stageId}`;
    if (stageKeys.has(key)) {
      issues.push(
        issue(
          'stage_events',
          'ERROR',
          'DUPLICATE_RULE',
          `stageEvents.${rule.id}.stageId`,
          `Die Stage „${rule.stageLabel ?? rule.stageId}“ ist mehr als einem Ereignis zugeordnet.`,
          'PUBLISH',
        ),
      );
    }
    stageKeys.add(key);

    if (m.pipeline.pipelineId && rule.pipelineId && rule.pipelineId !== m.pipeline.pipelineId) {
      issues.push(
        issue(
          'stage_events',
          'WARNING',
          'INCONSISTENT_PIPELINE',
          `stageEvents.${rule.id}.pipelineId`,
          `Die Regel „${rule.id}“ verweist auf eine andere Pipeline als die ausgewählte.`,
          'NONE',
        ),
      );
    }
  }
  for (const rule of m.propertyValueEvents) {
    if (ruleIds.has(rule.id)) {
      issues.push(
        issue(
          'property_value_events',
          'ERROR',
          'DUPLICATE_RULE',
          `propertyValueEvents.${rule.id}`,
          `Die Regel-ID „${rule.id}“ ist mehrfach vergeben.`,
          'PUBLISH',
        ),
      );
    }
    ruleIds.add(rule.id);
    const needsValues = !['IS_EMPTY', 'IS_NOT_EMPTY'].includes(rule.operator);
    if (needsValues && rule.values.length === 0) {
      issues.push(
        issue(
          'property_value_events',
          'ERROR',
          'MISSING_REQUIRED',
          `propertyValueEvents.${rule.id}.values`,
          `Die Regel „${rule.id}“ vergleicht ohne Vergleichswert.`,
          'PUBLISH',
        ),
      );
    }
  }
  for (const required of REQUIRED_MAPPED_EVENTS) {
    if (!mappedEvents.has(required)) {
      issues.push(
        issue(
          'stage_events',
          'ERROR',
          'UNMAPPED_EVENT',
          `stageEvents.${required}`,
          `Für das Pflichtereignis „${required}“ ist keine Stage und keine Wertregel hinterlegt.`,
          'LAUNCH',
        ),
      );
    }
  }

  /* --- revenue ----------------------------------------------------------- */
  if (!m.revenue.amountProperty) {
    issues.push(
      issue(
        'revenue',
        'ERROR',
        'MISSING_REQUIRED',
        'revenue.amountProperty',
        'Es ist keine Eigenschaft für den Umsatzbetrag hinterlegt.',
        'LAUNCH',
      ),
    );
  }
  if (!m.revenue.currencyProperty) {
    issues.push(
      issue(
        'revenue',
        'WARNING',
        'MISSING_REQUIRED',
        'revenue.currencyProperty',
        `Ohne Währungseigenschaft wird durchgängig ${m.revenue.fallbackCurrency} angenommen.`,
        'NONE',
      ),
    );
  }

  /* --- lost / no-show ---------------------------------------------------- */
  if (m.lostRules.lostStageIds.length === 0) {
    issues.push(
      issue(
        'lost_rules',
        'ERROR',
        'MISSING_REQUIRED',
        'lostRules.lostStageIds',
        'Es ist keine Stage als „verloren“ gekennzeichnet.',
        'LAUNCH',
      ),
    );
  }
  if (m.lostRules.noShowStageIds.length === 0 && !m.lostRules.noShowProperty) {
    issues.push(
      issue(
        'lost_rules',
        'WARNING',
        'MISSING_REQUIRED',
        'lostRules.noShowProperty',
        'Ohne No-Show-Regel bleiben nicht wahrgenommene Termine unsichtbar.',
        'NONE',
      ),
    );
  }

  /* --- VQ ---------------------------------------------------------------- */
  const vqCoveredByStages = m.stageEvents.some((r) =>
    ['VQ_SCHEDULED', 'VQ_PASSED', 'VQ_REJECTED'].includes(r.event),
  );
  if (!m.vq.statusProperty && !vqCoveredByStages) {
    issues.push(
      issue(
        'vq',
        'ERROR',
        'MISSING_REQUIRED',
        'vq.statusProperty',
        'Die VQ-Definition fehlt: weder eine Status-Eigenschaft noch VQ-Stages sind zugeordnet.',
        'LAUNCH',
      ),
    );
  }
  if (m.vq.statusProperty && Object.keys(m.vq.statusValueMap).length === 0) {
    issues.push(
      issue(
        'vq',
        'ERROR',
        'MISSING_REQUIRED',
        'vq.statusValueMap',
        'Für die VQ-Status-Eigenschaft ist keine Wertzuordnung hinterlegt.',
        'LAUNCH',
      ),
    );
  }

  /* --- acquisition ------------------------------------------------------- */
  for (const [scope, record] of [
    ['contactProperties', m.acquisition.contactProperties],
    ['dealProperties', m.acquisition.dealProperties],
  ] as const) {
    for (const key of Object.keys(record)) {
      if (!ACQUISITION_FIELD_KEYS.includes(key as AcquisitionFieldKey)) {
        issues.push(
          issue(
            'acquisition_fields',
            'ERROR',
            'UNKNOWN_ACQUISITION_SLOT',
            `acquisition.${scope}.${key}`,
            `„${key}“ ist kein bekanntes Akquisitionsfeld.`,
            'PUBLISH',
          ),
        );
      }
    }
  }
  for (const key of REQUIRED_ACQUISITION_FIELD_KEYS) {
    if (!m.acquisition.contactProperties[key] && !m.acquisition.dealProperties[key]) {
      issues.push(
        issue(
          'acquisition_fields',
          'ERROR',
          'MISSING_REQUIRED',
          `acquisition.contactProperties.${key}`,
          `Das Akquisitionsfeld „${key}“ wird nirgendwo nach HubSpot geschrieben — die Umsatzzuordnung bliebe unvollständig.`,
          'LAUNCH',
        ),
      );
    }
  }

  /* --- form fields ------------------------------------------------------- */
  const identifierMapped = m.formFieldMappings.some(
    (f) =>
      f.objectType === m.objects.contact && f.property === m.contactIdentifier.property,
  );
  if (!identifierMapped) {
    issues.push(
      issue(
        'form_fields',
        'ERROR',
        'NO_IDENTIFIER_FIELD',
        'formFieldMappings',
        `Kein Formularfeld schreibt in die Identifikationseigenschaft „${m.contactIdentifier.property}“.`,
        'LAUNCH',
      ),
    );
  }
  const seenFieldTargets = new Set<string>();
  for (const f of m.formFieldMappings) {
    const key = `${f.objectType}|${f.property}`;
    if (seenFieldTargets.has(key)) {
      issues.push(
        issue(
          'form_fields',
          'WARNING',
          'DUPLICATE_RULE',
          `formFieldMappings.${f.fieldKey}`,
          `Mehrere Formularfelder schreiben in „${f.property}“ — der letzte Wert gewinnt.`,
          'NONE',
        ),
      );
    }
    seenFieldTargets.add(key);
  }

  /* --- test lead --------------------------------------------------------- */
  if (!m.testLead.emailDomain) {
    issues.push(
      issue(
        'test_lead',
        'WARNING',
        'MISSING_REQUIRED',
        'testLead.emailDomain',
        'Für den Test-Lead ist keine E-Mail-Domain hinterlegt; der Test kann nicht live ausgeführt werden.',
        'NONE',
      ),
    );
  }

  /* --- webhooks ---------------------------------------------------------- */
  if (m.webhook.subscribedObjectTypes.length === 0) {
    issues.push(
      issue(
        'webhooks',
        'WARNING',
        'MISSING_REQUIRED',
        'webhook.subscribedObjectTypes',
        'Es sind keine Webhook-Abonnements hinterlegt; Änderungen werden nur über die Reconciliation erkannt.',
        'NONE',
      ),
    );
  }

  return finalize(issues);
}

function finalize(issues: MappingIssue[]): MappingValidationResult {
  const errors = issues.filter((i) => i.severity === 'ERROR');
  const warnings = issues.filter((i) => i.severity === 'WARNING');
  const order = new Map(MAPPING_WIZARD_STEPS.map((s) => [s.key, s.order]));
  const stepLabels = new Map(MAPPING_WIZARD_STEPS.map((s) => [s.key, s.labelDe]));
  const incompleteSteps = [...new Set(errors.map((e) => e.step))].sort(
    (a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0),
  );
  return {
    ok: errors.length === 0,
    issues,
    errors,
    warnings,
    incompleteStepsDe: incompleteSteps.map((s) => stepLabels.get(s) ?? s),
  };
}

/**
 * The launch gate. Live traffic stays blocked until every required mapping is
 * present — a partially configured portal must never receive real leads.
 */
export function requiredMappingsComplete(mapping: unknown): boolean {
  return validateMapping(mapping).ok;
}

/** The blocking issues, for rendering the "was fehlt noch?" list. */
export function missingRequiredMappings(mapping: unknown): MappingIssue[] {
  return validateMapping(mapping).errors;
}

/** True when the document may be saved as a new published version. */
export function canPublishMapping(mapping: unknown): boolean {
  return validateMapping(mapping).errors.every((i) => i.blocking !== 'PUBLISH');
}

/**
 * Publishes a draft as the next immutable version. The previous document is
 * never mutated — history always points at what was actually in force.
 */
export function publishMapping(
  draft: HubspotMappingDocument,
  options: { publishedBy: string; now: string; previousVersion?: number },
): { published: boolean; document: HubspotMappingDocument; issues: MappingIssue[] } {
  const validation = validateMapping(draft);
  const publishBlockers = validation.errors.filter((i) => i.blocking === 'PUBLISH');
  if (publishBlockers.length > 0) {
    return { published: false, document: draft, issues: publishBlockers };
  }
  const nextVersion = Math.max(draft.version, (options.previousVersion ?? 0) + 1);
  const document: HubspotMappingDocument = {
    ...draft,
    version: nextVersion,
    status: 'PUBLISHED',
    publishedAt: options.now,
    publishedBy: options.publishedBy,
  };
  return { published: true, document, issues: validation.issues };
}

/** Every canonical event the mapping can produce, for the wizard's coverage UI. */
export function mappedEventCoverage(
  mapping: HubspotMappingDocument,
): Record<SalesEventType, boolean> {
  const covered = new Set<SalesEventType>([
    ...mapping.stageEvents.map((r) => r.event),
    ...mapping.propertyValueEvents.map((r) => r.event),
    ...INTERNALLY_EMITTED_EVENTS,
  ]);
  return Object.fromEntries(SALES_EVENT_TYPES.map((t) => [t, covered.has(t)])) as Record<
    SalesEventType,
    boolean
  >;
}
