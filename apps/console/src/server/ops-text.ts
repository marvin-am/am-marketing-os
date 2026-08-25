import type { FeatureFlags } from '@am/domain';

/**
 * German copy shared by both `OpsPort` implementations.
 *
 * The feature-flag panel explains what each switch does and which environment
 * variable controls it. That text is a property of the product, not of the store
 * the rest of the screen was read from, so both implementations use the same
 * words rather than two copies that can drift.
 */
export const FLAG_VIEW_TEXTS_DE: Readonly<
  Record<keyof FeatureFlags, { labelDe: string; envVar: string; explanationDe: string }>
> = {
  demoMode: {
    labelDe: 'Demo-Modus',
    envVar: 'DEMO_MODE',
    explanationDe:
      'Alle Anbieter laufen gegen deterministische Fixtures. Es wird nie behauptet, ein echter Anbieter sei verbunden.',
  },
  externalWritesEnabled: {
    labelDe: 'Externe Schreibzugriffe',
    envVar: 'EXTERNAL_WRITES_ENABLED',
    explanationDe:
      'Hauptschalter. Solange er aus ist, liefert jeder Adapter einen Dry-Run statt eines Schreibvorgangs — unabhängig von den spezifischeren Schaltern.',
  },
  metaMutationsEnabled: {
    labelDe: 'Meta-Schreibzugriffe',
    envVar: 'META_MUTATIONS_ENABLED',
    explanationDe:
      'Erlaubt das Anlegen pausierter Entwürfe und Budget-/Statusänderungen — nur zusammen mit dem Hauptschalter.',
  },
  metaCapiEnabled: {
    labelDe: 'Conversions API',
    envVar: 'META_CAPI_ENABLED',
    explanationDe:
      'Erlaubt den serverseitigen Ereignisversand an Meta — nur zusammen mit dem Hauptschalter.',
  },
  hubspotWritesEnabled: {
    labelDe: 'HubSpot-Schreibzugriffe',
    envVar: 'HUBSPOT_WRITES_ENABLED',
    explanationDe:
      'Erlaubt das Anlegen und Aktualisieren von Kontakten und Deals — nur zusammen mit dem Hauptschalter.',
  },
};

/** German label for each outbox destination. */
export const OUTBOX_DESTINATION_LABELS_DE: Readonly<
  Record<'META_CAPI' | 'META_MARKETING_API' | 'HUBSPOT', string>
> = {
  META_CAPI: 'Meta Conversions API',
  META_MARKETING_API: 'Meta Marketing API',
  HUBSPOT: 'HubSpot',
};
