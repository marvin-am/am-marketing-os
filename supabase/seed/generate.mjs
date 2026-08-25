#!/usr/bin/env node
/**
 * Deterministic seed generator.
 *
 * Emits `supabase/seed/seed.sql`. Everything is derived from a fixed PRNG seed
 * and a counter-based UUID scheme, so the same command always produces byte-
 * identical SQL and the integration tests can assert on concrete numbers.
 *
 *   node supabase/seed/generate.mjs
 *
 * The emitted file is committed: reviewers read SQL, not a generator.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'seed.sql');

/* -------------------------------------------------------------------------- */
/* Determinism                                                                 */
/* -------------------------------------------------------------------------- */

/** mulberry32 — small, fast, and identical across Node versions. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = prng(20260825);
const pick = (list) => list[Math.floor(rand() * list.length)];
const between = (min, max) => min + Math.floor(rand() * (max - min + 1));
const chance = (p) => rand() < p;

/**
 * Stable UUIDs: `<hex(prefix)>-0000-4000-8000-<counter>`.
 *
 * The prefix is hashed into eight hex digits so an entity kind always lands in
 * the same UUID namespace — greppable in a dump, and identical on every run.
 */
const counters = new Map();
const prefixHex = new Map();
function uid(prefix) {
  let hex = prefixHex.get(prefix);
  if (!hex) {
    let h = 0x811c9dc5;
    for (let i = 0; i < prefix.length; i++) h = Math.imul(h ^ prefix.charCodeAt(i), 0x01000193) >>> 0;
    hex = h.toString(16).padStart(8, '0').slice(0, 8);
    prefixHex.set(prefix, hex);
  }
  const n = (counters.get(prefix) ?? 0) + 1;
  counters.set(prefix, n);
  return `${hex}-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/** Deterministic 64-hex "hash". Not cryptographic — a stable filler. */
function hash64(input) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    h1 = Math.imul(h1 ^ input.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 + input.charCodeAt(i), 0x85ebca6b) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).repeat(4);
}

/* -------------------------------------------------------------------------- */
/* SQL helpers                                                                 */
/* -------------------------------------------------------------------------- */

const chunks = [];
const say = (line = '') => chunks.push(line);

/**
 * Marks a value as JSON.
 *
 * A bare JS array is ambiguous — `['a','b']` could be `text[]` or a JSON array —
 * so arrays default to `text[]` (by far the more common column type here) and
 * anything destined for a `jsonb` column is wrapped in `J(...)`.
 */
const J = (value) => ({ __json: value });

function lit(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return `'${value.toISOString()}'`;
  if (typeof value === 'object' && value !== null && '__json' in value) {
    return `${lit(JSON.stringify(value.__json))}::jsonb`;
  }
  // Escape hatch for expressions such as decode(..., 'base64') that must reach
  // the database verbatim rather than as a literal.
  if (typeof value === 'object' && value !== null && '__raw' in value) return value.__raw;
  if (Array.isArray(value)) {
    if (value.length === 0) return `'{}'::text[]`;
    return `array[${value.map((v) => lit(v)).join(',')}]::text[]`;
  }
  if (typeof value === 'object') return `${lit(JSON.stringify(value))}::jsonb`;
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Emits a multi-row INSERT, chunked so no single statement gets unwieldy.
 *
 * Columns that are null in every row are dropped: the database default applies
 * anyway, and a wall of `null, null, null` makes the emitted SQL unreadable.
 *
 * Every statement ends `on conflict do nothing`, because `pnpm db:seed` is
 * documented as safe to re-run. Without it a second run aborts on the first
 * duplicate key and leaves the operator guessing whether anything was written.
 * The seed uses fixed UUIDs, so a re-run is genuinely a no-op rather than a
 * partial overwrite.
 */
function insert(table, columns, rows, { chunkSize = 200, conflictTarget = null } = {}) {
  if (rows.length === 0) return;
  const used = columns.filter((c) => rows.some((row) => row[c] !== null && row[c] !== undefined));
  if (used.length === 0) return;
  const onConflict = conflictTarget
    ? ` on conflict (${conflictTarget}) do nothing`
    : ' on conflict do nothing';
  for (let i = 0; i < rows.length; i += chunkSize) {
    const slice = rows.slice(i, i + chunkSize);
    say(`insert into public.${table} (${used.join(', ')}) values`);
    say(slice.map((row) => `  (${used.map((c) => lit(row[c])).join(',')})`).join(',\n') + onConflict + ';');
    say();
  }
}

const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

/** The demo's "now". Fixed so the emitted SQL never changes. */
const NOW = Date.parse('2026-08-25T09:00:00.000Z');
const MONTHS_18 = 548;

/* -------------------------------------------------------------------------- */
/* Fixed identities                                                            */
/* -------------------------------------------------------------------------- */

const WORKSPACE = '0a11b0a1-0000-4000-8000-000000000001';
const PROFILES = {
  admin: '0aaa0001-0000-4000-8000-000000000001',
  lead: '0aaa0001-0000-4000-8000-000000000002',
  operator: '0aaa0001-0000-4000-8000-000000000003',
  revops: '0aaa0001-0000-4000-8000-000000000004',
};
const BRAND = '0b4a0d01-0000-4000-8000-000000000001';
const CONSENT = '0c0e5e01-0000-4000-8000-000000000001';
const META_ACCOUNT = '0e7a0acc-0000-4000-8000-000000000001';

say('-- =============================================================================');
say('-- seed.sql — GENERATED by supabase/seed/generate.mjs. Do not edit by hand.');
say('-- =============================================================================');
say('-- A realistic 18-month demo workspace for A&M: brand knowledge, six historical');
say('-- Meta campaigns with daily insights, creatives, two concluded experiments,');
say('-- several hundred sessions, ~60 leads through the whole VQ → revenue funnel,');
say('-- deliberately failed HubSpot syncs and one dead-letter outbox row.');
say('--');
say('-- Deterministic: fixed PRNG seed, fixed UUIDs, fixed "now" = 2026-08-25.');
say('-- Apply after the migrations, as a role that bypasses RLS (postgres/service_role).');
say('-- =============================================================================');
say();
say('begin;');
say();

/* -------------------------------------------------------------------------- */
/* Workspace, profiles, membership                                             */
/* -------------------------------------------------------------------------- */

insert(
  'workspaces',
  ['id', 'slug', 'name', 'locale', 'default_currency', 'timezone', 'created_at', 'updated_at'],
  [
    {
      id: WORKSPACE,
      slug: 'am',
      name: 'A&M Unternehmerberatung',
      locale: 'de-DE',
      default_currency: 'EUR',
      timezone: 'Europe/Berlin',
      created_at: iso(NOW - MONTHS_18 * DAY),
      updated_at: iso(NOW),
    },
  ],
);

// `public.profiles.id` references `auth.users` wherever GoTrue (or the local
// shim) provides it. Seed the identities first so the constraint holds; on a
// bare Postgres without the auth schema this is a no-op.
say(`do $auth$`);
say(`begin`);
say(`  if to_regclass('auth.users') is not null then`);
say(`    insert into auth.users (id, email) values`);
say(
  Object.entries({
    [PROFILES.admin]: 'marvin@am-beratung.de',
    [PROFILES.lead]: 'marketing-lead@am-beratung.de',
    [PROFILES.operator]: 'marketing-ops@am-beratung.de',
    [PROFILES.revops]: 'revops@am-beratung.de',
  })
    .map(([id, email]) => `      (${lit(id)}, ${lit(email)})`)
    .join(',\n') + ' on conflict (id) do nothing;',
);
say(`  end if;`);
say(`end`);
say(`$auth$;`);
say();

insert(
  'profiles',
  ['id', 'email', 'display_name', 'locale', 'created_at', 'updated_at'],
  [
    { id: PROFILES.admin, email: 'marvin@am-beratung.de', display_name: 'Marvin Flenche', locale: 'de-DE', created_at: iso(NOW - MONTHS_18 * DAY), updated_at: iso(NOW) },
    { id: PROFILES.lead, email: 'marketing-lead@am-beratung.de', display_name: 'Marketing Lead', locale: 'de-DE', created_at: iso(NOW - 400 * DAY), updated_at: iso(NOW) },
    { id: PROFILES.operator, email: 'marketing-ops@am-beratung.de', display_name: 'Marketing Operator', locale: 'de-DE', created_at: iso(NOW - 380 * DAY), updated_at: iso(NOW) },
    { id: PROFILES.revops, email: 'revops@am-beratung.de', display_name: 'RevOps', locale: 'de-DE', created_at: iso(NOW - 360 * DAY), updated_at: iso(NOW) },
  ],
);

insert(
  'workspace_members',
  ['id', 'workspace_id', 'profile_id', 'roles', 'joined_at'],
  [
    { id: uid('0mem'), workspace_id: WORKSPACE, profile_id: PROFILES.admin, roles: ['ADMIN'], joined_at: iso(NOW - MONTHS_18 * DAY) },
    { id: uid('0mem'), workspace_id: WORKSPACE, profile_id: PROFILES.lead, roles: ['MARKETING_LEAD'], joined_at: iso(NOW - 400 * DAY) },
    { id: uid('0mem'), workspace_id: WORKSPACE, profile_id: PROFILES.operator, roles: ['MARKETING_OPERATOR', 'CREATIVE_REVIEWER'], joined_at: iso(NOW - 380 * DAY) },
    { id: uid('0mem'), workspace_id: WORKSPACE, profile_id: PROFILES.revops, roles: ['REVOPS'], joined_at: iso(NOW - 360 * DAY) },
  ],
);

insert(
  'role_limits',
  ['id', 'workspace_id', 'role', 'max_single_increase_pct', 'max_daily_budget_minor', 'max_scales_per_24h', 'may_pause'],
  [
    { id: uid('0rlim'), workspace_id: WORKSPACE, role: 'MARKETING_LEAD', max_single_increase_pct: 0.2, max_daily_budget_minor: 2_000_000, max_scales_per_24h: 1, may_pause: true },
    { id: uid('0rlim'), workspace_id: WORKSPACE, role: 'EXECUTIVE', max_single_increase_pct: 1.0, max_daily_budget_minor: 20_000_000, max_scales_per_24h: 4, may_pause: true },
    { id: uid('0rlim'), workspace_id: WORKSPACE, role: 'ADMIN', max_single_increase_pct: 1.0, max_daily_budget_minor: 20_000_000, max_scales_per_24h: 4, may_pause: true },
  ],
);

insert(
  'workspace_settings',
  ['workspace_id', 'experiment_thresholds', 'recommendation_config', 'retention_policy', 'attribution_window_days', 'form_abandon_minutes', 'historical_import_months', 'active_consent_version_id', 'vq_model_version'],
  [
    {
      workspace_id: WORKSPACE,
      experiment_thresholds: { minRuntimeDays: 7, maxRuntimeDays: 21, minSessionsPerArm: 200, minConversionsPerArm: 20, minWinProbability: 0.95, minRelativeLift: 0.1, crmMaturityDays: 21 },
      recommendation_config: { noLeadSpendMultiple: 1.5, noQualifiedVqSpendMultiple: 2.0, scaleStepPct: 0.2, scaleCooldownHours: 24, requireMatureCrmForScale: true, minLeadsForLeadingSignals: 5 },
      retention_policy: { submissionPiiDays: null, rawProviderPayloadDays: 180, analyticsEventDays: 730, auditLogDays: null },
      attribution_window_days: 30,
      form_abandon_minutes: 30,
      historical_import_months: 24,
      // Wired up after consent_versions is populated, further down.
      active_consent_version_id: null,
      vq_model_version: 'vq-2026-03',
    },
  ],
);

/* -------------------------------------------------------------------------- */
/* Brand knowledge                                                             */
/* -------------------------------------------------------------------------- */

insert(
  'brand_profiles',
  ['id', 'workspace_id', 'name', 'positioning', 'tone_of_voice', 'avoid_terms', 'preferred_terms', 'colors', 'logo_asset_path', 'is_default', 'created_by'],
  [
    {
      id: BRAND,
      workspace_id: WORKSPACE,
      name: 'A&M Unternehmerberatung',
      positioning:
        'A&M begleitet inhabergeführte mittelständische Unternehmen dabei, ihre Ertragskraft messbar zu steigern. ' +
        'Kein Konzernberatungs-Theater, sondern Zahlen, Klartext und Umsetzung an der Seite der Geschäftsführung.',
      tone_of_voice:
        'Direkt, sachlich, unternehmerisch. Wir sprechen Geschäftsführerinnen und Geschäftsführer auf Augenhöhe an, ' +
        'belegen jede Aussage mit einer Zahl und verzichten vollständig auf Superlative und Marketingfloskeln.',
      avoid_terms: ['günstig', 'billig', 'Schnäppchen', 'garantiert', 'revolutionär', 'Marktführer', 'Weltklasse', 'einzigartig'],
      preferred_terms: ['Ertragskraft', 'Potenzialanalyse', 'Deckungsbeitrag', 'Liquidität', 'Umsetzungsplan', 'Kennzahlen'],
      colors: { primary: '#D7182A', foreground: '#111111', background: '#FFFFFF', accent: '#000000' },
      logo_asset_path: 'brand-assets/am/logo-primary.svg',
      is_default: true,
      created_by: PROFILES.admin,
    },
  ],
);

const ICPS = [
  {
    id: uid('0icp'),
    name: 'Geschäftsführung Handwerk, 20–80 Mitarbeitende',
    description:
      'Inhabergeführte Handwerksbetriebe mit 20 bis 80 Mitarbeitenden. Volle Auftragsbücher, aber die Marge bleibt aus. ' +
      'Die Geschäftsführung steckt im Tagesgeschäft und hat keine belastbare Nachkalkulation.',
    company_size: '20–80 Mitarbeitende',
    industries: ['Elektrotechnik', 'SHK', 'Metallbau', 'Bauhandwerk'],
    roles: ['Geschäftsführung', 'Inhaber'],
    pain_points: ['Volle Auftragsbücher, kaum Gewinn', 'Keine belastbare Nachkalkulation', 'Preise seit Jahren nicht angepasst', 'Liquidität schwankt stark'],
    buying_triggers: ['Steuerberater meldet sinkende Marge', 'Erste Verlustaufträge sichtbar', 'Nachfolge oder Verkauf in Sicht'],
    objections: ['Berater kennen mein Gewerk nicht', 'Keine Zeit für Projekte', 'Habe schon einmal Geld für Beratung verbrannt'],
  },
  {
    id: uid('0icp'),
    name: 'Geschäftsführung produzierendes Gewerbe, 50–250 Mitarbeitende',
    description:
      'Produzierende Mittelständler mit 50 bis 250 Mitarbeitenden und gewachsener Produktvielfalt. ' +
      'Die Kostenstruktur ist intransparent, Deckungsbeiträge je Produktlinie sind unbekannt.',
    company_size: '50–250 Mitarbeitende',
    industries: ['Maschinenbau', 'Kunststoffverarbeitung', 'Lebensmittelproduktion', 'Zulieferindustrie'],
    roles: ['Geschäftsführung', 'Kaufmännische Leitung'],
    pain_points: ['Deckungsbeiträge je Produkt unbekannt', 'Energie- und Materialkosten gestiegen', 'Preiserhöhungen nicht durchsetzbar', 'Zu breites Sortiment'],
    buying_triggers: ['Bank fordert Sanierungskonzept', 'Rohertragsquote unter Branchenschnitt', 'Großkunde verhandelt Preise neu'],
    objections: ['Zahlen sind zu komplex für Externe', 'ERP-Daten sind nicht sauber', 'Betriebsrat könnte blockieren'],
  },
  {
    id: uid('0icp'),
    name: 'Geschäftsführung Dienstleistung/Agentur, 15–60 Mitarbeitende',
    description:
      'Inhabergeführte Dienstleister und Agenturen mit 15 bis 60 Mitarbeitenden. Wachstum über Umsatz, ' +
      'aber die Auslastung und die Projektmargen werden nicht systematisch gesteuert.',
    company_size: '15–60 Mitarbeitende',
    industries: ['Agentur', 'IT-Dienstleistung', 'Ingenieurbüro', 'Personaldienstleistung'],
    roles: ['Geschäftsführung', 'Partner'],
    pain_points: ['Projektmargen unbekannt', 'Auslastung schwankt', 'Zu viele Kleinkunden', 'Stundensätze zu niedrig'],
    buying_triggers: ['Wachstum ohne Gewinnsprung', 'Erste Kündigungen im Team', 'Kalkulation stimmt hinten nicht'],
    objections: ['Wir sind ein Sonderfall', 'Beratung kostet Beratungszeit', 'Zahlen sind im Kopf des Inhabers'],
  },
];

insert(
  'audience_segments',
  ['id', 'workspace_id', 'name', 'description', 'company_size', 'industries', 'roles', 'pain_points', 'buying_triggers', 'objections', 'sort_order', 'created_by'],
  ICPS.map((icp, index) => ({ ...icp, workspace_id: WORKSPACE, sort_order: index, created_by: PROFILES.admin })),
);

const SERVICES = [
  { id: uid('0svc'), name: 'Ertragskraft-Programm', description: 'Zwölfmonatige Begleitung zur systematischen Steigerung des Betriebsergebnisses: Nachkalkulation, Preisstrategie, Kostenstruktur, Umsetzungscontrolling.' },
  { id: uid('0svc'), name: 'Kalkulations- und Preisprojekt', description: 'Aufbau einer belastbaren Vor- und Nachkalkulation samt Preisstrategie und Verhandlungsleitfaden für Bestandskunden.' },
];
insert(
  'services',
  ['id', 'workspace_id', 'name', 'description', 'created_by'],
  SERVICES.map((s) => ({ ...s, workspace_id: WORKSPACE, created_by: PROFILES.admin })),
);

const OFFERS = [
  { id: uid('0off'), name: 'Kostenlose Potenzialanalyse', offer_type: 'POTENTIAL_ANALYSIS', service_id: SERVICES[0].id, valueExchange: 'Ein 45-minütiges Gespräch mit einer schriftlichen Einschätzung, wo im Betrieb wie viel Ergebnis liegt.', deliverable: 'Schriftliche Potenzialeinschätzung mit drei priorisierten Hebeln.', effortPromise: '2 Minuten', qualificationIntent: 'Betriebsgröße, Branche, Umsatz und aktuelle Ergebnissituation qualifizieren.' },
  { id: uid('0off'), name: 'Margen-Benchmark Handwerk', offer_type: 'BENCHMARK', service_id: SERVICES[1].id, valueExchange: 'Vergleich der eigenen Rohertragsquote mit anonymisierten Werten vergleichbarer Betriebe.', deliverable: 'Benchmark-Auswertung als PDF mit Einordnung des eigenen Betriebs.', effortPromise: '3 Minuten', qualificationIntent: 'Gewerk, Mitarbeiterzahl und Umsatzband erfassen.' },
  { id: uid('0off'), name: 'Kalkulations-Check', offer_type: 'AUDIT', service_id: SERVICES[1].id, valueExchange: 'Prüfung der bestehenden Kalkulation anhand von drei realen Aufträgen.', deliverable: 'Checkliste mit den gefundenen Kalkulationslücken.', effortPromise: '2 Minuten', qualificationIntent: 'Kalkulationsreife und Verantwortlichkeit klären.' },
];

insert(
  'offers',
  ['id', 'workspace_id', 'service_id', 'name', 'offer_type', 'created_by'],
  OFFERS.map((o) => ({ id: o.id, workspace_id: WORKSPACE, service_id: o.service_id, name: o.name, offer_type: o.offer_type, created_by: PROFILES.admin })),
);

const offerVersions = OFFERS.map((o) => ({
  id: uid('0offv'),
  workspace_id: WORKSPACE,
  offer_id: o.id,
  version: 1,
  state: 'PUBLISHED',
  spec: { name: o.name, type: o.offer_type, valueExchange: o.valueExchange, deliverable: o.deliverable, effortPromise: o.effortPromise, qualificationIntent: o.qualificationIntent },
  content_hash: hash64(`offer:${o.id}`),
  published_at: iso(NOW - 500 * DAY),
  published_by: PROFILES.lead,
  created_by: PROFILES.admin,
}));
insert('offer_versions', ['id', 'workspace_id', 'offer_id', 'version', 'state', 'spec', 'content_hash', 'published_at', 'published_by', 'created_by'], offerVersions);
say(`update public.offers o set current_version_id = v.id from public.offer_versions v where v.offer_id = o.id;`);
say();

const EVIDENCE = [
  { kind: 'APPROVED_STATISTIC', statement: 'Über 140 begleitete mittelständische Betriebe seit 2016.', source: 'Interne Mandantenstatistik, Stand 03/2026', numeric_value: 140, numeric_unit: 'Betriebe' },
  { kind: 'APPROVED_STATISTIC', statement: 'Im Median 4,2 Prozentpunkte höhere Umsatzrendite nach zwölf Monaten Begleitung.', source: 'Auswertung 58 abgeschlossener Mandate 2021–2025', numeric_value: 4.2, numeric_unit: 'Prozentpunkte' },
  { kind: 'HISTORICAL_PERFORMANCE', statement: 'Kampagnen mit konkreter Zahl in der Headline erreichten historisch eine um 31 % höhere Formularstartrate.', source: 'Meta-Insights + First-Party-Tracking, 18 Monate', numeric_value: 0.31, numeric_unit: 'relativ' },
  { kind: 'CUSTOMER_PROOF', statement: 'Ein Elektrobetrieb mit 42 Mitarbeitenden steigerte den Rohertrag binnen neun Monaten um 380.000 EUR.', source: 'Mandat E-2023-114, freigegeben durch den Mandanten', numeric_value: 380000, numeric_unit: 'EUR' },
  { kind: 'APPROVED_FACT', statement: 'Die Erstanalyse ist kostenfrei und unverbindlich.', source: 'Leistungsbeschreibung A&M, Stand 01/2026', numeric_value: null, numeric_unit: null },
  { kind: 'APPROVED_STATISTIC', statement: 'Durchschnittliche Projektlaufzeit bis zum ersten messbaren Ergebnis: 11 Wochen.', source: 'Auswertung 58 abgeschlossener Mandate 2021–2025', numeric_value: 11, numeric_unit: 'Wochen' },
];
const evidenceRows = EVIDENCE.map((e) => ({
  id: uid('0evi'),
  workspace_id: WORKSPACE,
  kind: e.kind,
  statement: e.statement,
  source: e.source,
  approved: true,
  approved_at: iso(NOW - 520 * DAY),
  approved_by: PROFILES.admin,
  numeric_value: e.numeric_value,
  numeric_unit: e.numeric_unit,
  created_by: PROFILES.admin,
}));
insert('evidence_items', ['id', 'workspace_id', 'kind', 'statement', 'source', 'approved', 'approved_at', 'approved_by', 'numeric_value', 'numeric_unit', 'created_by'], evidenceRows);

insert(
  'case_studies',
  ['id', 'workspace_id', 'client', 'industry', 'challenge', 'approach', 'outcome', 'metrics', 'approved', 'usable_in_ads', 'created_by'],
  [
    {
      id: uid('0case'), workspace_id: WORKSPACE, client: 'Elektrotechnik-Betrieb, 42 Mitarbeitende', industry: 'Elektrotechnik',
      challenge: 'Auftragsbücher voll, Betriebsergebnis seit drei Jahren rückläufig. Keine Nachkalkulation, Stundensätze seit 2019 unverändert.',
      approach: 'Nachkalkulation über 24 abgeschlossene Aufträge, Neuermittlung der Stundensätze, Preisgespräche mit den 15 größten Bestandskunden.',
      outcome: 'Rohertrag binnen neun Monaten um 380.000 EUR gesteigert, ohne einen einzigen Kunden zu verlieren.',
      metrics: J([{ label: 'Rohertrag', value: '+380.000 EUR' }, { label: 'Umsatzrendite', value: '+5,1 Prozentpunkte' }, { label: 'Kundenverluste', value: '0' }]),
      approved: true, usable_in_ads: true, created_by: PROFILES.admin,
    },
    {
      id: uid('0case'), workspace_id: WORKSPACE, client: 'Kunststoffverarbeiter, 130 Mitarbeitende', industry: 'Kunststoffverarbeitung',
      challenge: 'Über 400 Artikel im Sortiment, Deckungsbeiträge je Artikel unbekannt, Energiekosten verdoppelt.',
      approach: 'Deckungsbeitragsrechnung je Artikelgruppe, Sortimentsbereinigung, gestaffelte Preisanpassung mit Argumentationsleitfaden.',
      outcome: 'Sortiment um 27 % reduziert, EBIT-Marge von 2,1 % auf 6,8 % gesteigert.',
      metrics: J([{ label: 'EBIT-Marge', value: '2,1 % → 6,8 %' }, { label: 'Artikelanzahl', value: '−27 %' }]),
      approved: true, usable_in_ads: true, created_by: PROFILES.admin,
    },
    {
      id: uid('0case'), workspace_id: WORKSPACE, client: 'IT-Dienstleister, 38 Mitarbeitende', industry: 'IT-Dienstleistung',
      challenge: 'Starkes Umsatzwachstum, aber das Ergebnis blieb konstant. Projektmargen wurden nie gemessen.',
      approach: 'Projektnachkalkulation, Einführung von Auslastungs- und Margensteuerung, Fokussierung auf drei Kundensegmente.',
      outcome: 'Projektmarge im Median von 9 % auf 22 % gesteigert, Auslastung stabilisiert.',
      metrics: J([{ label: 'Projektmarge (Median)', value: '9 % → 22 %' }, { label: 'Auslastung', value: '68 % → 81 %' }]),
      approved: true, usable_in_ads: false, created_by: PROFILES.admin,
    },
  ],
);

insert(
  'testimonials',
  ['id', 'workspace_id', 'quote', 'author_name', 'author_role', 'company', 'approved', 'usable_in_ads', 'created_by'],
  [
    { id: uid('0test'), workspace_id: WORKSPACE, quote: 'Nach zwei Terminen wussten wir zum ersten Mal, welcher Auftrag uns tatsächlich Geld bringt. Das hat unsere Preisgespräche komplett verändert.', author_name: 'M. Karsten', author_role: 'Geschäftsführer', company: 'Elektrotechnik-Betrieb, 42 Mitarbeitende', approved: true, usable_in_ads: true, created_by: PROFILES.admin },
    { id: uid('0test'), workspace_id: WORKSPACE, quote: 'Kein Foliengewitter, sondern konkrete Zahlen aus unserem eigenen Betrieb. Genau das hatten wir gesucht.', author_name: 'S. Brehme', author_role: 'Inhaberin', company: 'Metallbau, 26 Mitarbeitende', approved: true, usable_in_ads: true, created_by: PROFILES.admin },
    { id: uid('0test'), workspace_id: WORKSPACE, quote: 'Die Potenzialanalyse hat 40 Minuten gedauert und uns eine sechsstellige Lücke gezeigt.', author_name: 'T. Wieland', author_role: 'Geschäftsführer', company: 'Maschinenbau, 95 Mitarbeitende', approved: true, usable_in_ads: true, created_by: PROFILES.admin },
    { id: uid('0test'), workspace_id: WORKSPACE, quote: 'Wir haben vorher schon einmal Geld für Beratung verbrannt. Hier war nach vier Wochen der erste Euro messbar.', author_name: 'A. Rennert', author_role: 'Partner', company: 'Ingenieurbüro, 34 Mitarbeitende', approved: true, usable_in_ads: false, created_by: PROFILES.admin },
  ],
);

insert(
  'faqs',
  ['id', 'workspace_id', 'question', 'answer', 'approved', 'sort_order', 'created_by'],
  [
    { id: uid('0faq'), workspace_id: WORKSPACE, question: 'Was kostet die Potenzialanalyse?', answer: 'Die Erstanalyse ist kostenfrei und unverbindlich. Erst wenn wir gemeinsam ein konkretes Potenzial identifiziert haben, sprechen wir über eine Zusammenarbeit.', approved: true, sort_order: 0, created_by: PROFILES.admin },
    { id: uid('0faq'), workspace_id: WORKSPACE, question: 'Wie viel Zeit muss ich einplanen?', answer: 'Für das Erstgespräch 45 Minuten. Die Vorbereitung übernehmen wir anhand der Angaben aus dem Formular.', approved: true, sort_order: 1, created_by: PROFILES.admin },
    { id: uid('0faq'), workspace_id: WORKSPACE, question: 'Brauche ich saubere Zahlen aus dem ERP?', answer: 'Nein. Wir arbeiten mit dem, was vorhanden ist, und zeigen im Verlauf, welche Kennzahlen künftig gepflegt werden sollten.', approved: true, sort_order: 2, created_by: PROFILES.admin },
    { id: uid('0faq'), workspace_id: WORKSPACE, question: 'Arbeiten Sie auch mit kleineren Betrieben?', answer: 'Unser Programm ist auf Betriebe ab etwa 15 Mitarbeitenden ausgelegt. Darunter fehlt in der Regel die Hebelwirkung.', approved: true, sort_order: 3, created_by: PROFILES.admin },
    { id: uid('0faq'), workspace_id: WORKSPACE, question: 'Was passiert mit meinen Daten?', answer: 'Ihre Angaben werden ausschließlich zur Vorbereitung des Gesprächs verwendet und nach den Vorgaben der DSGVO verarbeitet.', approved: true, sort_order: 4, created_by: PROFILES.admin },
  ],
);

insert(
  'guardrails',
  ['id', 'workspace_id', 'kind', 'pattern', 'match_mode', 'reason_de', 'severity', 'created_by'],
  [
    { id: uid('0grd'), workspace_id: WORKSPACE, kind: 'FORBIDDEN_TERM', pattern: 'garantiert', match_mode: 'WORD', reason_de: 'Ergebnisgarantien sind rechtlich angreifbar und passen nicht zur Positionierung.', severity: 'BLOCK', created_by: PROFILES.admin },
    { id: uid('0grd'), workspace_id: WORKSPACE, kind: 'FORBIDDEN_TERM', pattern: 'billig', match_mode: 'SUBSTRING', reason_de: 'Preisführerschaft ist explizit nicht Teil der Positionierung.', severity: 'BLOCK', created_by: PROFILES.admin },
    { id: uid('0grd'), workspace_id: WORKSPACE, kind: 'FORBIDDEN_CLAIM', pattern: 'Marktführer', match_mode: 'SUBSTRING', reason_de: 'Nicht belegbar; ohne Evidence-Item unzulässig.', severity: 'BLOCK', created_by: PROFILES.admin },
    { id: uid('0grd'), workspace_id: WORKSPACE, kind: 'REQUIRED_DISCLAIMER', pattern: 'Ergebnisse variieren je nach Ausgangslage.', match_mode: 'SUBSTRING', reason_de: 'Bei jeder konkreten Ergebniszahl im Creative erforderlich.', severity: 'WARN', created_by: PROFILES.admin },
    { id: uid('0grd'), workspace_id: WORKSPACE, kind: 'STYLE_RULE', pattern: '!!', match_mode: 'SUBSTRING', reason_de: 'Mehrfache Ausrufezeichen widersprechen dem sachlichen Tonfall.', severity: 'WARN', created_by: PROFILES.admin },
    { id: uid('0grd'), workspace_id: WORKSPACE, kind: 'FORBIDDEN_TERM', pattern: 'revolutionär', match_mode: 'WORD', reason_de: 'Superlativ ohne Substanz.', severity: 'BLOCK', created_by: PROFILES.admin },
  ],
);

insert(
  'consent_versions',
  ['id', 'workspace_id', 'version', 'text_de', 'purposes', 'privacy_policy_url', 'effective_from', 'created_by'],
  [
    {
      id: CONSENT,
      workspace_id: WORKSPACE,
      version: 1,
      text_de:
        'Ich willige ein, dass die A&M Unternehmerberatung meine Angaben zur Vorbereitung und Durchführung eines ' +
        'unverbindlichen Erstgesprächs verarbeitet und mich hierzu per E-Mail oder Telefon kontaktiert. ' +
        'Die Einwilligung kann jederzeit mit Wirkung für die Zukunft widerrufen werden.',
      purposes: ['CONTACT', 'AD_MEASUREMENT'],
      privacy_policy_url: 'https://www.am-beratung.de/datenschutz',
      effective_from: iso(NOW - 540 * DAY),
      created_by: PROFILES.admin,
    },
  ],
);

say(`update public.workspace_settings set active_consent_version_id = ${lit(CONSENT)} where workspace_id = ${lit(WORKSPACE)};`);
say();

/* -------------------------------------------------------------------------- */
/* Campaigns                                                                   */
/* -------------------------------------------------------------------------- */

const CAMPAIGN_BLUEPRINTS = [
  { name: 'Potenzialanalyse Handwerk Q1/25', slug: 'potenzialanalyse-handwerk-q1-25', state: 'COMPLETED', startOffset: 520, days: 74, icp: 0, offer: 0, dailyBudget: 12_000, cpl: 6_500, angle: 'Volle Auftragsbücher, leere Kasse', perspective: 'Auslastung ist kein Ergebnis. Der Betrieb arbeitet viel und verdient trotzdem zu wenig.' },
  { name: 'Margen-Benchmark Handwerk Q2/25', slug: 'margen-benchmark-handwerk-q2-25', state: 'COMPLETED', startOffset: 430, days: 68, icp: 0, offer: 1, dailyBudget: 15_000, cpl: 5_900, angle: 'Der Vergleich, den niemand macht', perspective: 'Jeder kennt seinen Umsatz, kaum jemand seine Rohertragsquote im Vergleich zur Branche.' },
  { name: 'Deckungsbeitrag Produktion Q3/25', slug: 'deckungsbeitrag-produktion-q3-25', state: 'COMPLETED', startOffset: 340, days: 82, icp: 1, offer: 0, dailyBudget: 18_000, cpl: 8_200, angle: 'Das teuerste Produkt ist das unbekannte', perspective: 'Ohne Deckungsbeitrag je Artikel subventioniert der Betrieb seine eigenen Verlustbringer.' },
  { name: 'Kalkulations-Check Handwerk Q4/25', slug: 'kalkulations-check-handwerk-q4-25', state: 'COMPLETED', startOffset: 250, days: 71, icp: 0, offer: 2, dailyBudget: 14_000, cpl: 6_100, angle: 'Der Stundensatz von 2019', perspective: 'Materialpreise und Löhne sind gestiegen, der kalkulierte Stundensatz meist nicht.' },
  { name: 'Ertragskraft Dienstleister Q1/26', slug: 'ertragskraft-dienstleister-q1-26', state: 'COMPLETED', startOffset: 160, days: 64, icp: 2, offer: 0, dailyBudget: 16_000, cpl: 7_400, angle: 'Wachstum ohne Gewinnsprung', perspective: 'Mehr Umsatz bei gleichem Ergebnis heißt: Das Wachstum wird intern aufgezehrt.' },
  { name: 'Potenzialanalyse Handwerk Q3/26', slug: 'potenzialanalyse-handwerk-q3-26', state: 'LIVE', startOffset: 46, days: 46, icp: 0, offer: 0, dailyBudget: 22_000, cpl: 5_400, angle: 'Elf Wochen bis zum ersten messbaren Euro', perspective: 'Die Frage ist nicht ob Potenzial da ist, sondern wie schnell es sichtbar wird.' },
];

const campaigns = [];
const angles = [];
const angleVersions = [];
const campaignVersions = [];
const campaignAngles = [];
const approvals = [];
const proposals = [];

for (const [index, bp] of CAMPAIGN_BLUEPRINTS.entries()) {
  const campaignId = uid('0camp');
  const angleId = uid('0ang');
  const angleVersionId = uid('0angv');
  const versionId = uid('0campv');
  const startAt = NOW - bp.startOffset * DAY;
  const endAt = startAt + bp.days * DAY;
  const live = bp.state === 'LIVE';

  angles.push({
    id: angleId, workspace_id: WORKSPACE, name: bp.angle, perspective: bp.perspective,
    rationale: `Der Angle spricht ${ICPS[bp.icp].name} über die Diskrepanz zwischen Auslastung und Ergebnis an.`,
    keywords: bp.angle.toLowerCase().split(/[^a-zäöüß]+/).filter((w) => w.length > 3).slice(0, 6),
    first_used_campaign_id: campaignId, last_used_at: iso(startAt), use_count: 1, created_by: PROFILES.operator,
  });

  angleVersions.push({
    id: angleVersionId, workspace_id: WORKSPACE, angle_id: angleId, version: 1, state: 'PUBLISHED',
    spec: { name: bp.angle, perspective: bp.perspective, rationale: `Perspektive für ${ICPS[bp.icp].name}.`, keywords: ['ertragskraft', 'kalkulation', 'marge', 'potenzial'] },
    content_hash: hash64(`angle:${angleId}`), distinctness_verdict: 'DISTINCT', max_similarity: Number((0.4 + rand() * 0.3).toFixed(5)),
    published_at: iso(startAt - 7 * DAY), published_by: PROFILES.lead, created_by: PROFILES.operator,
  });

  campaigns.push({
    id: campaignId, workspace_id: WORKSPACE, name: bp.name, slug: bp.slug, state: bp.state,
    brand_profile_id: BRAND, audience_segment_id: ICPS[bp.icp].id, service_id: OFFERS[bp.offer].service_id,
    offer_id: OFFERS[bp.offer].id, offer_version_id: offerVersions[bp.offer].id,
    angle_id: angleId, angle_version_id: angleVersionId, current_version_id: versionId,
    core_message: `${bp.angle} — belegt mit Zahlen aus dem eigenen Betrieb.`,
    hypothesis: `Wenn wir ${ICPS[bp.icp].name} mit einer konkreten Ergebniszahl ansprechen, steigt die Formularstartrate gegenüber einer generischen Nutzenaussage.`,
    currency: 'EUR', daily_budget_minor: bp.dailyBudget, test_budget_minor: bp.dailyBudget * bp.days,
    target_cpl_minor: bp.cpl, target_cost_per_qualified_vq_minor: bp.cpl * 6,
    primary_metric: 'cost_per_qualified_vq', secondary_metrics: ['cpl', 'submission_rate', 'show_rate'], guardrail_metrics: ['ctr', 'form_start_rate'],
    attribution_level: 'REVENUE_LINKED', tags: ['meta', ICPS[bp.icp].industries[0].toLowerCase()],
    planned_start_at: iso(startAt), planned_end_at: iso(endAt), launched_at: iso(startAt),
    completed_at: live ? null : iso(endAt), created_at: iso(startAt - 21 * DAY), updated_at: iso(live ? NOW : endAt),
    created_by: PROFILES.operator, updated_by: PROFILES.lead,
  });

  campaignVersions.push({
    id: versionId, workspace_id: WORKSPACE, campaign_id: campaignId, version: 1, state: 'PUBLISHED',
    spec: { campaignName: bp.name, angle: bp.angle, offer: OFFERS[bp.offer].name, audience: ICPS[bp.icp].name, dailyBudgetMinor: bp.dailyBudget, targetCplMinor: bp.cpl },
    content_hash: hash64(`campaign:${campaignId}`), notes: 'Freigegeben nach Strategie-Review.',
    published_at: iso(startAt - 5 * DAY), published_by: PROFILES.lead,
    created_at: iso(startAt - 14 * DAY), updated_at: iso(startAt - 5 * DAY), created_by: PROFILES.operator,
  });

  campaignAngles.push({ id: uid('0cang'), workspace_id: WORKSPACE, campaign_id: campaignId, angle_id: angleId, angle_version_id: angleVersionId, role: 'PRIMARY', created_by: PROFILES.operator });

  for (const kind of ['STRATEGY', 'ASSETS', 'TEST_PLAN', 'PUBLISH']) {
    approvals.push({
      id: uid('0appr'), workspace_id: WORKSPACE, campaign_id: campaignId, kind, state: 'APPROVED',
      approved_content_hash: hash64(`${kind}:${campaignId}`), approved_by: PROFILES.lead,
      approved_at: iso(startAt - 4 * DAY), requested_by: PROFILES.operator,
      created_at: iso(startAt - 6 * DAY), updated_at: iso(startAt - 4 * DAY),
    });
  }

  proposals.push({
    id: uid('0prop'), workspace_id: WORKSPACE, campaign_id: campaignId, model: 'gpt-5.6-sol', generation_index: 1,
    proposal: { campaignName: bp.name, angle: { name: bp.angle, perspective: bp.perspective }, offer: { name: OFFERS[bp.offer].name, type: OFFERS[bp.offer].offer_type }, creativeConceptCount: 6, funnelVariantCount: 3 },
    content_hash: hash64(`proposal:${campaignId}`), diversity_score: Number((0.62 + rand() * 0.28).toFixed(5)),
    angle_verdict: 'DISTINCT', max_similarity: Number((0.35 + rand() * 0.35).toFixed(5)),
    similar_campaigns: J(index === 0 ? [] : [{ campaignId: campaigns[index - 1].id, campaignName: campaigns[index - 1].name, similarity: Number((0.4 + rand() * 0.3).toFixed(3)) }]),
    accepted: true, accepted_at: iso(startAt - 12 * DAY), accepted_by: PROFILES.lead,
    created_at: iso(startAt - 13 * DAY), updated_at: iso(startAt - 12 * DAY), created_by: PROFILES.operator,
  });
}

// Insertion order resolves the circular references: angles and campaigns point
// at each other, and campaigns point at a version that does not exist yet.
insert(
  'angles',
  ['id', 'workspace_id', 'name', 'perspective', 'rationale', 'keywords', 'last_used_at', 'use_count', 'created_by'],
  angles,
);
insert('campaigns', Object.keys(campaigns[0]), campaigns.map((c) => ({ ...c, angle_id: null, angle_version_id: null, current_version_id: null })));
insert('angle_versions', Object.keys(angleVersions[0]), angleVersions);
insert('campaign_versions', Object.keys(campaignVersions[0]), campaignVersions);
for (const campaign of campaigns) {
  say(
    `update public.campaigns set angle_id = ${lit(campaign.angle_id)}, angle_version_id = ${lit(campaign.angle_version_id)}, ` +
      `current_version_id = ${lit(campaign.current_version_id)} where id = ${lit(campaign.id)};`,
  );
}
say();
say(`update public.angles a set first_used_campaign_id = c.id from public.campaigns c where c.angle_id = a.id;`);
say(`update public.angles a set current_version_id = v.id from public.angle_versions v where v.angle_id = a.id;`);
say();
insert('campaign_angles', Object.keys(campaignAngles[0]), campaignAngles);
insert('approvals', Object.keys(approvals[0]), approvals);
insert('campaign_proposals', Object.keys(proposals[0]), proposals);

/* -------------------------------------------------------------------------- */
/* Creatives                                                                   */
/* -------------------------------------------------------------------------- */

const PRINCIPLES = ['PROBLEM_PAIN', 'CONCRETE_RESULT', 'COMPARISON_ALTERNATIVE', 'PROOF_CASE_DATAPOINT', 'OBJECTION_HANDLING', 'CONTRARIAN_INSIGHT'];
const PRINCIPLE_COPY = {
  PROBLEM_PAIN: { headline: 'Volle Auftragsbücher, zu wenig Ergebnis?', primary: 'Viele Betriebe arbeiten am Limit und sehen am Jahresende trotzdem kaum Gewinn. Meistens liegt es nicht an den Kunden, sondern an der Kalkulation. In 45 Minuten zeigen wir Ihnen, wo im Betrieb Ergebnis liegt.' },
  CONCRETE_RESULT: { headline: '380.000 EUR mehr Rohertrag in 9 Monaten', primary: 'Ein Elektrobetrieb mit 42 Mitarbeitenden hat binnen neun Monaten 380.000 EUR mehr Rohertrag erwirtschaftet — ohne einen einzigen Kunden zu verlieren. Ergebnisse variieren je nach Ausgangslage.' },
  COMPARISON_ALTERNATIVE: { headline: 'Steuerberater oder Kalkulation?', primary: 'Der Steuerberater zeigt Ihnen, was war. Eine belastbare Nachkalkulation zeigt Ihnen, was künftig geht. Beides ist nötig — nur eines davon steuert Ihr Ergebnis.' },
  PROOF_CASE_DATAPOINT: { headline: '4,2 Prozentpunkte mehr Umsatzrendite', primary: 'Über 58 abgeschlossene Mandate hinweg liegt der Median bei 4,2 Prozentpunkten höherer Umsatzrendite nach zwölf Monaten. Wir zeigen Ihnen in 45 Minuten, welcher Hebel bei Ihnen zuerst greift.' },
  OBJECTION_HANDLING: { headline: 'Schon einmal Geld für Beratung verbrannt?', primary: 'Die Sorge ist berechtigt. Deshalb ist unsere Erstanalyse kostenfrei und endet mit drei priorisierten Hebeln, die Sie auch ohne uns umsetzen können.' },
  CONTRARIAN_INSIGHT: { headline: 'Mehr Umsatz ist selten die Lösung', primary: 'Wer bei zu dünner Marge wächst, vergrößert das Problem. Die interessantere Frage ist, welcher Auftrag heute tatsächlich Geld bringt — und welcher nicht.' },
};

const concepts = [];
const creativeVersions = [];
const creativeRenditions = [];
const creativeAssets = [];

for (const [index, campaign] of campaigns.entries()) {
  const conceptCount = campaign.state === 'LIVE' ? 6 : 4;
  for (let c = 0; c < conceptCount; c++) {
    const principle = PRINCIPLES[c % PRINCIPLES.length];
    const conceptId = uid('0conc');
    const versionId = uid('0crev');
    const assetId = uid('0cass');
    const copy = PRINCIPLE_COPY[principle];
    const approved = c < conceptCount - 1 || campaign.state !== 'LIVE';

    creativeAssets.push({
      id: assetId, workspace_id: WORKSPACE, concept_id: conceptId, campaign_id: campaign.id,
      media_kind: 'IMAGE', source: 'AI_GENERATED', storage_bucket: 'creative-source',
      storage_path: `${campaign.slug}/concept_${c + 1}/base.png`, mime_type: 'image/png',
      width: 1536, height: 1536, byte_size: between(680_000, 1_900_000), checksum: hash64(`asset:${assetId}`),
      provider: 'INTERNAL', external_id: `asset:${assetId}`, created_by: PROFILES.operator,
    });

    concepts.push({
      id: conceptId, workspace_id: WORKSPACE, campaign_id: campaign.id, campaign_version_id: campaign.current_version_id,
      concept_key: `concept_${c + 1}`, name: `${copy.headline.slice(0, 40)} (${principle})`, principle,
      visual_idea: 'Aufgeräumter Werkstatt- oder Produktionsraum, Geschäftsführer mittleren Alters am Stehtisch mit Tablet, natürliches Seitenlicht, keine Stock-Ästhetik.',
      image_prompt: 'Documentary style photograph of a German mid-sized workshop interior, owner in work clothing reviewing figures on a tablet, natural side light, muted palette, no text, no logos, no user interface elements.',
      copy: { primaryText: copy.primary, headline: copy.headline, description: 'Kostenlose Potenzialanalyse · 45 Minuten · unverbindlich', callToAction: 'Mehr dazu' },
      hypothesis: `Das Prinzip ${principle} spricht die Ergebnislücke direkter an als eine generische Nutzenaussage und erhöht die Formularstartrate.`,
      rationale: 'Konzept folgt dem Kommunikationsprinzip und nutzt ausschließlich freigegebene Evidence-Items.',
      proof_used: principle === 'PROOF_CASE_DATAPOINT' || principle === 'CONCRETE_RESULT' ? evidenceRows[1].statement : null,
      funnel_promise: 'Schriftliche Potenzialeinschätzung mit drei priorisierten Hebeln.',
      alt_text: 'Geschäftsführer prüft betriebswirtschaftliche Kennzahlen auf einem Tablet in seiner Werkstatt.',
      aspect_ratios: ['1:1', '4:5'], claims: J([]), review_state: approved ? 'APPROVED' : 'IN_REVIEW',
      reviewed_by: approved ? PROFILES.operator : null, reviewed_at: approved ? iso(NOW - campaign.state === 'LIVE' ? 40 * DAY : 200 * DAY) : null,
      current_version_id: versionId, diversity_hash: hash64(`div:${conceptId}`), sort_order: c,
      created_by: PROFILES.operator,
    });

    creativeVersions.push({
      id: versionId, workspace_id: WORKSPACE, concept_id: conceptId, campaign_id: campaign.id, version: 1,
      state: 'PUBLISHED', base_asset_id: assetId,
      render_spec: { layout: 'headline-bottom-left', safeArea: true, brandBar: true, logo: 'brand-assets/am/logo-primary.svg' },
      copy: { primaryText: copy.primary, headline: copy.headline, description: 'Kostenlose Potenzialanalyse · 45 Minuten · unverbindlich', callToAction: 'Mehr dazu' },
      content_hash: hash64(`creativeversion:${versionId}`), review_state: approved ? 'APPROVED' : 'IN_REVIEW',
      approved_by: approved ? PROFILES.operator : null, approved_at: approved ? iso(NOW - 200 * DAY) : null,
      published_at: iso(NOW - (campaign.state === 'LIVE' ? 44 : 210 + index * 10) * DAY), published_by: PROFILES.lead,
      created_by: PROFILES.operator,
    });

    for (const ratio of ['1:1', '4:5']) {
      creativeRenditions.push({
        id: uid('0cren'), workspace_id: WORKSPACE, creative_version_id: versionId, aspect_ratio: ratio,
        storage_bucket: 'creative-renditions', storage_path: `${campaign.slug}/concept_${c + 1}/${ratio.replace(':', 'x')}.png`,
        mime_type: 'image/png', width: ratio === '1:1' ? 1080 : 1080, height: ratio === '1:1' ? 1080 : 1350,
        byte_size: between(240_000, 620_000), checksum: hash64(`rend:${versionId}:${ratio}`),
        render_duration_ms: between(420, 2600), renderer_version: '1', created_by: PROFILES.operator,
      });
    }
  }
}

insert('creative_concepts', Object.keys(concepts[0]), concepts.map((c) => ({ ...c, current_version_id: null })));
insert('creative_assets', Object.keys(creativeAssets[0]), creativeAssets);
insert('creative_versions', Object.keys(creativeVersions[0]), creativeVersions);
say(`update public.creative_concepts c set current_version_id = v.id from public.creative_versions v where v.concept_id = c.id;`);
say();
insert('creative_renditions', Object.keys(creativeRenditions[0]), creativeRenditions);

/* -------------------------------------------------------------------------- */
/* Funnels and forms                                                           */
/* -------------------------------------------------------------------------- */

const FIELD_INDEX = {
  mitarbeiterzahl: { type: 'SINGLE_SELECT', pii_class: 'QUALIFICATION', qualification_class: 'SCORING', step_key: 'betrieb' },
  jahresumsatz: { type: 'SINGLE_SELECT', pii_class: 'QUALIFICATION', qualification_class: 'SCORING', step_key: 'betrieb' },
  branche: { type: 'SINGLE_SELECT', pii_class: 'QUALIFICATION', qualification_class: 'ROUTING_ONLY', step_key: 'betrieb' },
  ergebnissituation: { type: 'SINGLE_SELECT', pii_class: 'QUALIFICATION', qualification_class: 'SCORING', step_key: 'situation' },
  zeithorizont: { type: 'SINGLE_SELECT', pii_class: 'QUALIFICATION', qualification_class: 'DISQUALIFYING', step_key: 'situation' },
  rolle: { type: 'SINGLE_SELECT', pii_class: 'QUALIFICATION', qualification_class: 'DISQUALIFYING', step_key: 'kontakt' },
  vorname: { type: 'FIRST_NAME', pii_class: 'PII', qualification_class: 'NONE', step_key: 'kontakt' },
  nachname: { type: 'LAST_NAME', pii_class: 'PII', qualification_class: 'NONE', step_key: 'kontakt' },
  email: { type: 'EMAIL', pii_class: 'PII', qualification_class: 'NONE', step_key: 'kontakt' },
  telefon: { type: 'PHONE', pii_class: 'PII', qualification_class: 'NONE', step_key: 'kontakt' },
  einwilligung: { type: 'CONSENT', pii_class: 'OPERATIONAL', qualification_class: 'NONE', step_key: 'kontakt' },
};

const ANSWER_OPTIONS = {
  mitarbeiterzahl: ['unter 15', '15-30', '31-60', '61-120', 'über 120'],
  jahresumsatz: ['unter 2 Mio', '2-5 Mio', '5-12 Mio', '12-30 Mio', 'über 30 Mio'],
  branche: ['Elektrotechnik', 'SHK', 'Metallbau', 'Maschinenbau', 'IT-Dienstleistung', 'Sonstiges'],
  ergebnissituation: ['deutlich rückläufig', 'leicht rückläufig', 'stabil', 'wachsend'],
  zeithorizont: ['sofort', 'in 1-3 Monaten', 'in 3-6 Monaten', 'nur Information'],
  rolle: ['Geschäftsführung', 'Inhaber', 'Kaufmännische Leitung', 'Mitarbeitende'],
};

const funnels = [];
const funnelVersions = [];
const formDefinitions = [];
const formVersions = [];
const publishedFunnels = [];

for (const campaign of campaigns) {
  const variants = [
    { key: 'funnel_1', kind: 'MULTI_STEP_FORM', name: 'Multi-Step 5 Fragen', questions: 5 },
    { key: 'funnel_2', kind: 'MULTI_STEP_FORM', name: 'Multi-Step 6 Fragen', questions: 6 },
    { key: 'funnel_3', kind: 'LANDING_PAGE', name: 'Landingpage Kurzformular', questions: 4 },
  ];
  for (const [i, variant] of variants.entries()) {
    const funnelId = uid('0funn');
    const funnelVersionId = uid('0funv');
    const formId = uid('0form');
    const formVersionId = uid('0forv');
    const publishedId = uid('0pubf');
    const publishedAt = iso(NOW - (campaign.state === 'LIVE' ? 46 : 240) * DAY);

    funnels.push({ id: funnelId, workspace_id: WORKSPACE, campaign_id: campaign.id, funnel_key: variant.key, kind: variant.kind, name: variant.name, promise: 'In zwei Minuten zur schriftlichen Potenzialeinschätzung.', hypothesis: `Variante ${variant.key} konvertiert besser, weil die Qualifizierungstiefe zur Zielgruppe passt.`, rationale: 'Testvariante aus dem Kampagnenvorschlag.', current_version_id: null, created_by: PROFILES.operator });
    formDefinitions.push({ id: formId, workspace_id: WORKSPACE, funnel_id: funnelId, form_key: 'qualifizierung', name: 'Qualifizierung', current_version_id: null, created_by: PROFILES.operator });
    formVersions.push({
      id: formVersionId, workspace_id: WORKSPACE, form_definition_id: formId, version: 1, state: 'PUBLISHED',
      spec: { steps: [{ key: 'betrieb', fields: ['mitarbeiterzahl', 'jahresumsatz', 'branche'] }, { key: 'situation', fields: ['ergebnissituation', 'zeithorizont'] }, { key: 'kontakt', fields: ['rolle', 'vorname', 'nachname', 'email', 'telefon', 'einwilligung'] }] },
      field_index: FIELD_INDEX, question_count: variant.questions, content_hash: hash64(`form:${formVersionId}`),
      consent_version_id: CONSENT, published_at: publishedAt, published_by: PROFILES.lead, created_by: PROFILES.operator,
    });
    funnelVersions.push({
      id: funnelVersionId, workspace_id: WORKSPACE, funnel_id: funnelId, campaign_id: campaign.id, version: 1, state: 'PUBLISHED',
      spec: { kind: variant.kind, blocks: ['hero', 'proof', 'form', 'faq'], promise: 'Schriftliche Potenzialeinschätzung in 45 Minuten.' },
      content_hash: hash64(`funnel:${funnelVersionId}`), form_version_id: formVersionId,
      published_at: publishedAt, published_by: PROFILES.lead, created_by: PROFILES.operator,
    });
    publishedFunnels.push({
      id: publishedId, workspace_id: WORKSPACE, campaign_id: campaign.id, funnel_id: funnelId,
      funnel_version_id: funnelVersionId, form_version_id: formVersionId, experiment_id: null,
      public_slug: `${campaign.slug}-${variant.key.replace('funnel_', 'v')}`, path: '/', is_live: campaign.state === 'LIVE',
      environment: 'production', meta_pixel_id: 'AWAITING_EXTERNAL_INPUT', meta_dataset_id: 'AWAITING_EXTERNAL_INPUT',
      consent_version_id: CONSENT, published_at: publishedAt, unpublished_at: campaign.state === 'LIVE' ? null : iso(NOW - 150 * DAY),
      created_by: PROFILES.lead,
    });
    campaign[`funnel_${i}`] = { funnelId, funnelVersionId, formVersionId, publishedId };
  }
}

insert('funnels', Object.keys(funnels[0]), funnels);
insert('form_definitions', Object.keys(formDefinitions[0]), formDefinitions);
insert('form_versions', Object.keys(formVersions[0]), formVersions);
insert('funnel_versions', Object.keys(funnelVersions[0]), funnelVersions);
say(`update public.funnels f set current_version_id = v.id from public.funnel_versions v where v.funnel_id = f.id;`);
say(`update public.form_definitions d set current_version_id = v.id from public.form_versions v where v.form_definition_id = d.id;`);
say();
insert('published_funnels', Object.keys(publishedFunnels[0]), publishedFunnels);

/* -------------------------------------------------------------------------- */
/* Experiments                                                                 */
/* -------------------------------------------------------------------------- */

const experiments = [];
const experimentArms = [];
const experimentResults = [];

const EXPERIMENT_BLUEPRINTS = [
  { campaignIndex: 2, kind: 'FUNNEL_EXPERIMENT', name: 'Fünf vs. sechs Qualifizierungsfragen', hypothesis: 'Eine zusätzliche Qualifizierungsfrage senkt die Abschlussrate, erhöht aber den Anteil qualifizierter VQs so stark, dass die Kosten je qualifiziertem VQ sinken.', variable: 'Anzahl Qualifizierungsfragen', verdict: 'WINNER' },
  { campaignIndex: 4, kind: 'CREATIVE_EXPLORATION', name: 'Konkrete Ergebniszahl vs. Problemzuspitzung', hypothesis: 'Ein Creative mit konkreter Ergebniszahl erzielt eine höhere Formularstartrate als eine reine Problemzuspitzung.', variable: 'Kommunikationsprinzip im Creative', verdict: 'NO_DIFFERENCE' },
];

for (const bp of EXPERIMENT_BLUEPRINTS) {
  const campaign = campaigns[bp.campaignIndex];
  const experimentId = uid('0expr');
  const startedAt = Date.parse(campaign.launched_at) + 3 * DAY;
  const concludedAt = startedAt + 18 * DAY;
  const controlId = uid('0arm');
  const variantId = uid('0arm');

  experiments.push({
    id: experimentId, workspace_id: WORKSPACE, campaign_id: campaign.id, kind: bp.kind, state: 'CONCLUDED',
    name: bp.name, hypothesis: bp.hypothesis, test_variable: bp.variable,
    primary_metric: bp.kind === 'FUNNEL_EXPERIMENT' ? 'cost_per_qualified_vq' : 'form_start_rate',
    secondary_metrics: ['submission_rate', 'cpl'], guardrail_metrics: ['ctr'],
    thresholds: { minRuntimeDays: 7, maxRuntimeDays: 21, minSessionsPerArm: 200, minConversionsPerArm: 20, minWinProbability: 0.95, minRelativeLift: 0.1, crmMaturityDays: 21 },
    assignment_salt: hash64(`salt:${experimentId}`).slice(0, 32), bundled: false, eligibility_changing: bp.kind === 'FUNNEL_EXPERIMENT',
    verdict: bp.verdict, winning_arm_id: null, started_at: iso(startedAt), concluded_at: iso(concludedAt),
    created_at: iso(startedAt - 2 * DAY), updated_at: iso(concludedAt), created_by: PROFILES.operator, updated_by: PROFILES.lead,
  });

  experimentArms.push(
    { id: controlId, workspace_id: WORKSPACE, experiment_id: experimentId, key: 'control', label: 'Kontrolle', is_control: true, allocation: 0.5, funnel_version_id: campaign.funnel_0.funnelVersionId, form_version_id: campaign.funnel_0.formVersionId, creative_version_id: null, published_funnel_id: campaign.funnel_0.publishedId, sort_order: 0, created_by: PROFILES.operator },
    { id: variantId, workspace_id: WORKSPACE, experiment_id: experimentId, key: 'variant_b', label: 'Variante B', is_control: false, allocation: 0.5, funnel_version_id: campaign.funnel_1.funnelVersionId, form_version_id: campaign.funnel_1.formVersionId, creative_version_id: null, published_funnel_id: campaign.funnel_1.publishedId, sort_order: 1, created_by: PROFILES.operator },
  );

  const controlRate = 0.041 + rand() * 0.01;
  const variantRate = bp.verdict === 'WINNER' ? controlRate * 1.34 : controlRate * 1.02;

  experimentResults.push({
    id: uid('0expres'), workspace_id: WORKSPACE, experiment_id: experimentId, computed_at: iso(concludedAt),
    primary_metric: bp.kind === 'FUNNEL_EXPERIMENT' ? 'cost_per_qualified_vq' : 'form_start_rate',
    verdict: bp.verdict, winning_arm_id: bp.verdict === 'WINNER' ? variantId : null,
    maturity: 'MATURE',
    arms: J([
      { arm_id: controlId, arm_key: 'control', label: 'Kontrolle', is_control: true, conversionRate: { numerator: 27, denominator: 654, value: Number(controlRate.toFixed(5)) }, posteriorMean: Number(controlRate.toFixed(5)), credibleInterval: [Number((controlRate * 0.72).toFixed(5)), Number((controlRate * 1.34).toFixed(5))], probabilityBest: bp.verdict === 'WINNER' ? 0.028 : 0.47, relativeLiftVsControl: null, meetsMinSessions: true, meetsMinConversions: true },
      { arm_id: variantId, arm_key: 'variant_b', label: 'Variante B', is_control: false, conversionRate: { numerator: 36, denominator: 641, value: Number(variantRate.toFixed(5)) }, posteriorMean: Number(variantRate.toFixed(5)), credibleInterval: [Number((variantRate * 0.74).toFixed(5)), Number((variantRate * 1.31).toFixed(5))], probabilityBest: bp.verdict === 'WINNER' ? 0.972 : 0.53, relativeLiftVsControl: Number((variantRate / controlRate - 1).toFixed(5)), meetsMinSessions: true, meetsMinConversions: true },
    ]),
    reasons: bp.verdict === 'WINNER' ? ['MIN_RUNTIME_REACHED', 'MIN_CONVERSIONS_REACHED', 'WIN_PROBABILITY_ABOVE_THRESHOLD'] : ['MIN_RUNTIME_REACHED', 'LIFT_BELOW_PRACTICAL_THRESHOLD'],
    interpretation_warnings: bp.kind === 'FUNNEL_EXPERIMENT' ? ['ELIGIBILITY_CHANGED_BETWEEN_ARMS'] : [],
    runtime_days: 18, total_sessions: 1295, total_conversions: 63,
    thresholds: { minRuntimeDays: 7, maxRuntimeDays: 21, minSessionsPerArm: 200, minConversionsPerArm: 20, minWinProbability: 0.95, minRelativeLift: 0.1, crmMaturityDays: 21 },
  });

  campaign.experiment = { id: experimentId, controlId, variantId, startedAt, concludedAt };
}

insert('experiments', Object.keys(experiments[0]), experiments);
insert('experiment_arms', Object.keys(experimentArms[0]), experimentArms);
say(`update public.experiments e set winning_arm_id = a.id from public.experiment_arms a where a.experiment_id = e.id and a.key = 'variant_b' and e.verdict = 'WINNER';`);
say();
say(`update public.published_funnels pf set experiment_id = a.experiment_id from public.experiment_arms a where a.published_funnel_id = pf.id;`);
say();
insert('experiment_results', Object.keys(experimentResults[0]), experimentResults);

/* -------------------------------------------------------------------------- */
/* Meta objects and 18 months of daily insights                                */
/* -------------------------------------------------------------------------- */

insert(
  'meta_accounts',
  ['id', 'workspace_id', 'provider', 'external_id', 'name', 'currency', 'timezone', 'business_id', 'page_id', 'pixel_id', 'dataset_id', 'account_status', 'is_primary', 'last_imported_at', 'created_by'],
  [{ id: META_ACCOUNT, workspace_id: WORKSPACE, provider: 'META', external_id: 'act_100000000000001', name: 'A&M Unternehmerberatung', currency: 'EUR', timezone: 'Europe/Berlin', business_id: '200000000000001', page_id: '300000000000001', pixel_id: 'AWAITING_EXTERNAL_INPUT', dataset_id: 'AWAITING_EXTERNAL_INPUT', account_status: 'ACTIVE', is_primary: true, last_imported_at: iso(NOW - DAY), created_by: PROFILES.admin }],
);

const metaCampaigns = [];
const metaAdSets = [];
const metaCreatives = [];
const metaAds = [];
const insights = [];

for (const [index, campaign] of campaigns.entries()) {
  const mcId = uid('0mcam');
  const externalCampaignId = `2380000000000${String(index + 10).padStart(4, '0')}`;
  const startAt = Date.parse(campaign.launched_at);
  const days = Math.round((Date.parse(campaign.completed_at ?? iso(NOW)) - startAt) / DAY);

  metaCampaigns.push({
    id: mcId, workspace_id: WORKSPACE, meta_account_id: META_ACCOUNT, provider: 'META', external_id: externalCampaignId,
    campaign_id: campaign.id, name: campaign.name, objective: 'OUTCOME_LEADS',
    status: campaign.state === 'LIVE' ? 'ACTIVE' : 'PAUSED', effective_status: campaign.state === 'LIVE' ? 'ACTIVE' : 'CAMPAIGN_PAUSED',
    buying_type: 'AUCTION', daily_budget_minor: campaign.daily_budget_minor, currency: 'EUR',
    start_time: iso(startAt), stop_time: campaign.completed_at, provider_created_time: iso(startAt - 2 * DAY),
    provider_updated_time: iso(startAt + days * DAY), raw: { objective: 'OUTCOME_LEADS', special_ad_categories: [] }, imported_at: iso(NOW - DAY),
  });

  const experiment = campaign.experiment ?? null;
  const adsetSpecs = [
    { suffix: 'Breit', armId: experiment?.controlId ?? null },
    { suffix: 'Interessen', armId: experiment?.variantId ?? null },
  ];

  for (const [a, spec] of adsetSpecs.entries()) {
    const adsetId = uid('0mset');
    const externalAdsetId = `${externalCampaignId}${a + 1}`;
    metaAdSets.push({
      id: adsetId, workspace_id: WORKSPACE, meta_campaign_id: mcId, provider: 'META', external_id: externalAdsetId,
      name: `${campaign.name} – ${spec.suffix}`, status: campaign.state === 'LIVE' ? 'ACTIVE' : 'PAUSED',
      effective_status: campaign.state === 'LIVE' ? 'ACTIVE' : 'ADSET_PAUSED', optimization_goal: 'OFFSITE_CONVERSIONS',
      billing_event: 'IMPRESSIONS', bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      daily_budget_minor: Math.round(campaign.daily_budget_minor / 2),
      targeting: { geo_locations: { countries: ['DE'] }, age_min: 30, age_max: 65, interests: spec.suffix === 'Interessen' ? ['Unternehmensführung', 'Handwerk'] : [] },
      start_time: iso(startAt), end_time: campaign.completed_at, experiment_arm_id: spec.armId,
      raw: {}, imported_at: iso(NOW - DAY),
    });

    const campaignConcepts = concepts.filter((c) => c.campaign_id === campaign.id).slice(0, 3);
    for (const [k, concept] of campaignConcepts.entries()) {
      const creativeId = uid('0mcre');
      const adId = uid('0mad');
      const externalCreativeId = `${externalAdsetId}${k + 1}0`;
      const externalAdId = `${externalAdsetId}${k + 1}1`;
      const version = creativeVersions.find((v) => v.concept_id === concept.id);

      metaCreatives.push({
        id: creativeId, workspace_id: WORKSPACE, meta_account_id: META_ACCOUNT, provider: 'META', external_id: externalCreativeId,
        name: concept.name, creative_version_id: version.id, creative_rendition_id: null,
        object_story_spec: { page_id: '300000000000001', link_data: { message: concept.copy.primaryText, name: concept.copy.headline, description: concept.copy.description, call_to_action: { type: 'LEARN_MORE' } } },
        image_hash: hash64(`imghash:${creativeId}`).slice(0, 32), title: concept.copy.headline, body: concept.copy.primaryText,
        call_to_action_type: 'LEARN_MORE', link_url: `https://funnel.am-beratung.de/${campaign.slug}-v1`,
        raw: {}, imported_at: iso(NOW - DAY),
      });

      metaAds.push({
        id: adId, workspace_id: WORKSPACE, meta_adset_id: adsetId, meta_creative_id: creativeId, provider: 'META',
        external_id: externalAdId, name: `${concept.concept_key} – ${concept.principle}`,
        status: campaign.state === 'LIVE' ? 'ACTIVE' : 'PAUSED', effective_status: campaign.state === 'LIVE' ? 'ACTIVE' : 'AD_PAUSED',
        creative_version_id: version.id, tracking_specs: J([]), raw: {}, imported_at: iso(NOW - DAY),
      });

      // Daily ad-level insights.
      for (let d = 0; d < days; d++) {
        const dayMs = startAt + d * DAY;
        if (dayMs > NOW) break;
        const weekday = new Date(dayMs).getUTCDay();
        const weekendFactor = weekday === 0 || weekday === 6 ? 0.55 : 1;
        const fatigue = Math.max(0.55, 1 - d / (days * 2.4));
        const base = campaign.daily_budget_minor / (adsetSpecs.length * campaignConcepts.length);
        const spend = Math.round(base * weekendFactor * fatigue * (0.8 + rand() * 0.4));
        const cpmMinor = between(900, 2400);
        const impressions = Math.max(1, Math.round((spend / cpmMinor) * 1000));
        const ctr = 0.008 + rand() * 0.014;
        const clicks = Math.max(0, Math.round(impressions * ctr));
        const linkClicks = Math.max(0, Math.round(clicks * (0.62 + rand() * 0.2)));
        insights.push({
          id: uid('0mins'), workspace_id: WORKSPACE, provider: 'META', level: 'AD', entity_external_id: externalAdId,
          meta_account_id: META_ACCOUNT, meta_campaign_id: mcId, meta_adset_id: adsetId, meta_ad_id: adId,
          campaign_id: campaign.id, date_start: day(dayMs), impressions, reach: Math.round(impressions * (0.6 + rand() * 0.25)),
          clicks, link_clicks: linkClicks, spend_minor: spend, currency: 'EUR',
          frequency: Number((1.1 + rand() * 0.9).toFixed(4)), cpm_minor: cpmMinor,
          cpc_minor: clicks > 0 ? Math.round(spend / clicks) : null, ctr: Number(ctr.toFixed(6)),
          video_views: 0, actions: J([{ action_type: 'lead', value: String(between(0, 2)) }]), action_values: J([]),
          raw: {}, imported_at: iso(NOW - DAY),
        });
      }
    }
  }

  campaign.metaCampaignId = mcId;
  campaign.metaExternalId = externalCampaignId;
}

// Campaign-level rollups, derived from the ad rows so the numbers reconcile.
const rollup = new Map();
for (const row of insights) {
  const key = `${row.meta_campaign_id}|${row.date_start}`;
  const acc = rollup.get(key) ?? { impressions: 0, reach: 0, clicks: 0, link_clicks: 0, spend_minor: 0, row };
  acc.impressions += row.impressions;
  acc.reach += row.reach;
  acc.clicks += row.clicks;
  acc.link_clicks += row.link_clicks;
  acc.spend_minor += row.spend_minor;
  rollup.set(key, acc);
}
for (const [, acc] of rollup) {
  const src = acc.row;
  const mc = metaCampaigns.find((m) => m.id === src.meta_campaign_id);
  insights.push({
    id: uid('0mins'), workspace_id: WORKSPACE, provider: 'META', level: 'CAMPAIGN', entity_external_id: mc.external_id,
    meta_account_id: META_ACCOUNT, meta_campaign_id: mc.id, meta_adset_id: null, meta_ad_id: null,
    campaign_id: mc.campaign_id, date_start: src.date_start, impressions: acc.impressions, reach: acc.reach,
    clicks: acc.clicks, link_clicks: acc.link_clicks, spend_minor: acc.spend_minor, currency: 'EUR',
    frequency: Number((acc.impressions / Math.max(acc.reach, 1)).toFixed(4)),
    cpm_minor: acc.impressions > 0 ? Math.round((acc.spend_minor / acc.impressions) * 1000) : null,
    cpc_minor: acc.clicks > 0 ? Math.round(acc.spend_minor / acc.clicks) : null,
    ctr: acc.impressions > 0 ? Number((acc.clicks / acc.impressions).toFixed(6)) : null,
    video_views: 0, actions: J([]), action_values: J([]), raw: {}, imported_at: iso(NOW - DAY),
  });
}

insert('meta_campaigns', Object.keys(metaCampaigns[0]), metaCampaigns);
insert('meta_adsets', Object.keys(metaAdSets[0]), metaAdSets);
insert('meta_creatives', Object.keys(metaCreatives[0]), metaCreatives);
insert('meta_ads', Object.keys(metaAds[0]), metaAds);
insert('meta_insights_daily', Object.keys(insights[0]), insights, { chunkSize: 400 });

/* -------------------------------------------------------------------------- */
/* Traffic, submissions, leads, revenue                                        */
/* -------------------------------------------------------------------------- */

const visitors = [];
const sessions = [];
const events = [];
const formInstances = [];
const submissions = [];
const answers = [];
const piiRows = [];
const statusHistory = [];
const snapshots = [];
const leads = [];
const stageEvents = [];
const opportunities = [];
const revenueEvents = [];
const touchpoints = [];
const outbox = [];
const hubspotObjects = [];
const hubspotAttempts = [];
const hubspotStages = [];
const capiDispatches = [];

const FIRST_NAMES = ['Michael', 'Sabine', 'Thomas', 'Andrea', 'Stefan', 'Claudia', 'Jörg', 'Petra', 'Dirk', 'Ute', 'Frank', 'Birgit'];
const LAST_NAMES = ['Karsten', 'Brehme', 'Wieland', 'Rennert', 'Hoffmann', 'Schuster', 'Lindner', 'Bergmann', 'Kohl', 'Vogt'];
const COMPANY_DOMAINS = ['elektro-karsten.de', 'metallbau-brehme.de', 'wieland-maschinen.de', 'rennert-ingenieure.de', 'hoffmann-shk.de', 'schuster-kunststoff.de', 'lindner-it.de'];

let leadCounter = 0;
const TARGET_LEADS = 60;

for (const campaign of campaigns) {
  const startAt = Date.parse(campaign.launched_at);
  const days = Math.round((Date.parse(campaign.completed_at ?? iso(NOW)) - startAt) / DAY);
  const sessionCount = campaign.state === 'LIVE' ? 140 : between(80, 120);
  const experiment = campaign.experiment ?? null;

  for (let s = 0; s < sessionCount; s++) {
    const visitorId = uid('0vis');
    const sessionId = uid('0sess');
    const offsetDays = Math.floor(rand() * Math.max(days, 1));
    const at = startAt + offsetDays * DAY + Math.floor(rand() * DAY);
    if (at > NOW) continue;

    const variantIndex = experiment ? (s % 2) : Math.floor(rand() * 3);
    const variant = campaign[`funnel_${Math.min(variantIndex, 2)}`];
    const armId = experiment ? (variantIndex === 0 ? experiment.controlId : experiment.variantId) : null;
    const metaAd = metaAds.find((ad) => metaAdSets.some((set) => set.id === ad.meta_adset_id && set.meta_campaign_id === campaign.metaCampaignId));

    visitors.push({ id: visitorId, workspace_id: WORKSPACE, first_seen_at: iso(at), last_seen_at: iso(at + between(60_000, 900_000)), traffic_kind: 'PRODUCTION', consent_status: 'UNKNOWN', session_count: 1, created_at: iso(at) });
    sessions.push({
      id: sessionId, workspace_id: WORKSPACE, visitor_id: visitorId, started_at: iso(at), last_activity_at: iso(at + between(30_000, 600_000)),
      environment: 'production', traffic_kind: 'PRODUCTION', consent_status: 'UNKNOWN', channel: 'META_PAID',
      landing_url: `https://funnel.am-beratung.de/${variant ? publishedFunnels.find((p) => p.id === variant.publishedId).public_slug : campaign.slug}`,
      referrer: 'https://l.facebook.com/', utm_source: 'facebook', utm_medium: 'paid_social', utm_campaign: campaign.slug,
      utm_content: 'concept_1', utm_term: null, fbclid: hash64(`fbclid:${sessionId}`).slice(0, 40), fbc: null, fbp: null,
      meta_campaign_id: campaign.metaExternalId, meta_adset_id: null, meta_ad_id: metaAd ? metaAd.external_id : null,
      published_funnel_id: variant.publishedId, funnel_version_id: variant.funnelVersionId, campaign_id: campaign.id,
      experiment_id: experiment ? experiment.id : null, experiment_arm_id: armId,
      device_bucket: pick(['MOBILE', 'MOBILE', 'MOBILE', 'DESKTOP', 'TABLET']), event_count: 0, created_at: iso(at),
    });

    touchpoints.push({
      id: uid('0touch'), workspace_id: WORKSPACE, visitor_id: visitorId, session_id: sessionId, occurred_at: iso(at),
      channel: 'META_PAID', role: 'ACQUISITION', confidence: 'EXACT', from_signed_token: true,
      campaign_id: campaign.id, campaign_version_id: campaign.current_version_id, angle_id: campaign.angle_id,
      angle_version_id: campaign.angle_version_id, offer_id: campaign.offer_id, offer_version_id: campaign.offer_version_id,
      creative_id: null, creative_version_id: null, funnel_id: variant.funnelId, funnel_version_id: variant.funnelVersionId,
      form_id: null, form_version_id: variant.formVersionId, experiment_id: experiment ? experiment.id : null, experiment_arm_id: armId,
      utm_source: 'facebook', utm_medium: 'paid_social', utm_campaign: campaign.slug, utm_content: 'concept_1', utm_term: null,
      fbclid: hash64(`fbclid:${sessionId}`).slice(0, 40), fbc: null, fbp: null,
      meta_campaign_id: campaign.metaExternalId, meta_adset_id: null, meta_ad_id: metaAd ? metaAd.external_id : null,
      referrer: 'https://l.facebook.com/', landing_url: null, created_at: iso(at),
    });

    const pushEvent = (type, offsetMs, extra = {}) =>
      events.push({
        id: uid('0evt'), workspace_id: WORKSPACE, event_type: type, event_schema_version: 1,
        occurred_at: iso(at + offsetMs), received_at: iso(at + offsetMs + 400), environment: 'production', traffic_kind: 'PRODUCTION',
        visitor_id: visitorId, session_id: sessionId, campaign_id: campaign.id, campaign_version_id: campaign.current_version_id,
        angle_id: campaign.angle_id, angle_version_id: campaign.angle_version_id, offer_id: campaign.offer_id,
        offer_version_id: campaign.offer_version_id, creative_id: null, creative_version_id: null,
        funnel_id: variant.funnelId, funnel_version_id: variant.funnelVersionId, form_id: null, form_version_id: variant.formVersionId,
        experiment_id: experiment ? experiment.id : null, experiment_arm_id: armId,
        form_instance_id: extra.form_instance_id ?? null, submission_id: extra.submission_id ?? null,
        step_id: extra.step_id ?? null, field_id: extra.field_id ?? null, error_code: extra.error_code ?? null,
        consent_status: extra.consent_status ?? 'UNKNOWN', utm_source: 'facebook', utm_medium: 'paid_social',
        utm_campaign: campaign.slug, utm_content: 'concept_1', utm_term: null, fbclid: null, fbc: null, fbp: null,
        meta_campaign_id: campaign.metaExternalId, meta_adset_id: null, meta_ad_id: metaAd ? metaAd.external_id : null,
        referrer: 'https://l.facebook.com/', landing_url: null, metadata: extra.metadata ?? {},
      });

    pushEvent('funnel_viewed', 0);
    if (experiment) pushEvent('experiment_exposed', 500, { metadata: { arm: armId === experiment.controlId ? 'control' : 'variant_b' } });

    const started = chance(0.42);
    if (!started) continue;

    const instanceId = uid('0finst');
    formInstances.push({
      id: instanceId, workspace_id: WORKSPACE, published_funnel_id: variant.publishedId, funnel_version_id: variant.funnelVersionId,
      form_version_id: variant.formVersionId, visitor_id: visitorId, session_id: sessionId, campaign_id: campaign.id,
      experiment_id: experiment ? experiment.id : null, experiment_arm_id: armId, started_at: iso(at + 4_000),
      last_activity_at: iso(at + 90_000), completed_at: null, abandoned_at: null, current_step_key: 'betrieb',
      steps_completed: 0, step_count: 3, environment: 'production', traffic_kind: 'PRODUCTION',
      created_at: iso(at + 4_000), updated_at: iso(at + 90_000),
    });

    pushEvent('form_viewed', 3_000, { form_instance_id: instanceId });
    pushEvent('form_started', 4_000, { form_instance_id: instanceId, step_id: 'betrieb' });
    pushEvent('form_step_viewed', 5_000, { form_instance_id: instanceId, step_id: 'betrieb', metadata: { step_index: 1 } });

    const reachedStep2 = chance(0.72);
    if (!reachedStep2) {
      formInstances[formInstances.length - 1].abandoned_at = iso(at + 35 * 60_000);
      pushEvent('form_abandoned', 35 * 60_000, { form_instance_id: instanceId, step_id: 'betrieb' });
      continue;
    }
    pushEvent('form_step_completed', 25_000, { form_instance_id: instanceId, step_id: 'betrieb', metadata: { step_index: 1 } });
    pushEvent('form_step_viewed', 26_000, { form_instance_id: instanceId, step_id: 'situation', metadata: { step_index: 2 } });

    if (chance(0.12)) pushEvent('form_validation_failed', 30_000, { form_instance_id: instanceId, step_id: 'situation', field_id: 'zeithorizont', error_code: 'REQUIRED' });

    const reachedStep3 = chance(0.7);
    if (!reachedStep3) {
      formInstances[formInstances.length - 1].abandoned_at = iso(at + 35 * 60_000);
      formInstances[formInstances.length - 1].steps_completed = 1;
      pushEvent('form_abandoned', 35 * 60_000, { form_instance_id: instanceId, step_id: 'situation' });
      continue;
    }
    pushEvent('form_step_completed', 48_000, { form_instance_id: instanceId, step_id: 'situation', metadata: { step_index: 2 } });
    pushEvent('form_step_viewed', 49_000, { form_instance_id: instanceId, step_id: 'kontakt', metadata: { step_index: 3 } });

    const submitted = chance(0.58) && leadCounter < TARGET_LEADS;
    if (!submitted) {
      formInstances[formInstances.length - 1].abandoned_at = iso(at + 35 * 60_000);
      formInstances[formInstances.length - 1].steps_completed = 2;
      pushEvent('form_abandoned', 35 * 60_000, { form_instance_id: instanceId, step_id: 'kontakt' });
      continue;
    }

    /* ---- an accepted submission with a full CRM life cycle ---------------- */
    leadCounter += 1;
    const submissionId = uid('0subm');
    const attemptId = uid('0att');
    const snapshotId = uid('0snap');
    const leadId = uid('0lead');
    const personId = uid('0pers');
    const submittedAt = at + 78_000;

    formInstances[formInstances.length - 1].completed_at = iso(submittedAt);
    formInstances[formInstances.length - 1].steps_completed = 3;
    formInstances[formInstances.length - 1].current_step_key = 'kontakt';

    pushEvent('lead_submit_attempted', 76_000, { form_instance_id: instanceId, consent_status: 'GRANTED' });
    pushEvent('lead_submitted', 78_000, { form_instance_id: instanceId, submission_id: submissionId, consent_status: 'GRANTED' });
    pushEvent('thank_you_viewed', 80_000, { form_instance_id: instanceId, submission_id: submissionId, consent_status: 'GRANTED' });

    const employees = pick(ANSWER_OPTIONS.mitarbeiterzahl.slice(1));
    const revenueBand = pick(ANSWER_OPTIONS.jahresumsatz.slice(1));
    const situation = pick(ANSWER_OPTIONS.ergebnissituation);
    const horizon = pick(ANSWER_OPTIONS.zeithorizont);
    const role = chance(0.85) ? pick(['Geschäftsführung', 'Inhaber']) : pick(['Kaufmännische Leitung', 'Mitarbeitende']);
    const industry = pick(ANSWER_OPTIONS.branche);

    submissions.push({
      id: submissionId, workspace_id: WORKSPACE, submission_attempt_id: attemptId, form_instance_id: instanceId,
      form_version_id: variant.formVersionId, funnel_version_id: variant.funnelVersionId, published_funnel_id: variant.publishedId,
      campaign_id: campaign.id, experiment_id: experiment ? experiment.id : null, experiment_arm_id: armId,
      visitor_id: visitorId, session_id: sessionId, state: 'HUBSPOT_SYNCED', submitted_at: iso(submittedAt),
      accepted_at: iso(submittedAt), environment: 'production', traffic_kind: 'PRODUCTION',
      consent_version_id: CONSENT, consent_status: 'GRANTED', consent_purposes: ['CONTACT', 'AD_MEASUREMENT'],
      consent_text_hash: hash64('consent:v1'), spam_score: Number((rand() * 0.2).toFixed(4)), spam_reason: null,
      validation_error_codes: [], answers_hash: hash64(`answers:${submissionId}`),
      attribution_snapshot_id: snapshotId, lead_id: leadId, created_at: iso(submittedAt), updated_at: iso(submittedAt + DAY),
    });

    for (const [key, value] of Object.entries({ mitarbeiterzahl: employees, jahresumsatz: revenueBand, branche: industry, ergebnissituation: situation, zeithorizont: horizon, rolle: role })) {
      answers.push({
        id: uid('0ans'), workspace_id: WORKSPACE, submission_id: submissionId, field_key: key,
        step_key: FIELD_INDEX[key].step_key, field_type: FIELD_INDEX[key].type, pii_class: 'QUALIFICATION',
        qualification_class: FIELD_INDEX[key].qualification_class, value_text: value, value_number: null,
        value_bool: null, value_options: null,
        score_contribution: FIELD_INDEX[key].qualification_class === 'SCORING' ? between(5, 25) : null,
        created_at: iso(submittedAt),
      });
    }
    answers.push({
      id: uid('0ans'), workspace_id: WORKSPACE, submission_id: submissionId, field_key: 'einwilligung', step_key: 'kontakt',
      field_type: 'CONSENT', pii_class: 'OPERATIONAL', qualification_class: 'NONE', value_text: null, value_number: null,
      value_bool: true, value_options: null, score_contribution: null, created_at: iso(submittedAt),
    });

    // PII: ciphertext placeholders only. The demo never holds real personal data.
    const firstName = pick(FIRST_NAMES);
    const lastName = pick(LAST_NAMES);
    const domain = pick(COMPANY_DOMAINS);
    piiRows.push({
      id: uid('0pii'), workspace_id: WORKSPACE, submission_id: submissionId, algorithm: 'AES-256-GCM', key_version: 1,
      iv: `DEMO-IV-${submissionId.slice(-12)}`,
      auth_tag: `DEMO-TAG-${submissionId.slice(-12)}`,
      ciphertext: `DEMO-CIPHERTEXT-${submissionId.slice(-12)}`,
      email_hash: hash64(`email:${firstName}.${lastName}@${domain}`), phone_hash: hash64(`phone:${submissionId}`),
      email_domain: domain, created_at: iso(submittedAt),
    });

    for (const [i, state] of ['CREATED', 'VALIDATED', 'ACCEPTED', 'HUBSPOT_PENDING', 'HUBSPOT_SYNCED'].entries()) {
      statusHistory.push({
        id: uid('0shist'), workspace_id: WORKSPACE, submission_id: submissionId,
        from_state: i === 0 ? null : ['CREATED', 'VALIDATED', 'ACCEPTED', 'HUBSPOT_PENDING'][i - 1],
        to_state: state, occurred_at: iso(submittedAt + i * 1_500), reason_de: null,
        actor_label: i < 3 ? 'funnel-runtime' : 'hubspot-sync', correlation_id: null, created_at: iso(submittedAt + i * 1_500),
      });
    }

    snapshots.push({
      id: snapshotId, workspace_id: WORKSPACE, submission_id: submissionId, frozen: true,
      campaign_id: campaign.id, campaign_version_id: campaign.current_version_id, angle_id: campaign.angle_id,
      angle_version_id: campaign.angle_version_id, offer_id: campaign.offer_id, offer_version_id: campaign.offer_version_id,
      creative_id: null, creative_version_id: null, funnel_id: variant.funnelId, funnel_version_id: variant.funnelVersionId,
      form_id: null, form_version_id: variant.formVersionId, experiment_id: experiment ? experiment.id : null, experiment_arm_id: armId,
      first_touch: null, last_touch: null, acquisition_touch: { channel: 'META_PAID', occurred_at: iso(at), confidence: 'EXACT' },
      influenced_touch_ids: null, utm_source: 'facebook', utm_medium: 'paid_social', utm_campaign: campaign.slug,
      utm_content: 'concept_1', utm_term: null, fbclid: hash64(`fbclid:${sessionId}`).slice(0, 40), fbc: null, fbp: null,
      meta_campaign_id: campaign.metaExternalId, meta_adset_id: null, meta_ad_id: metaAd ? metaAd.external_id : null,
      referrer: 'https://l.facebook.com/', landing_url: null, channel: 'META_PAID', level: 'REVENUE_LINKED',
      confidence: chance(0.86) ? 'EXACT' : pick(['HIGH_CONFIDENCE', 'MEDIUM_CONFIDENCE']), consent_status: 'GRANTED',
      days_to_conversion: 0, window_days: 30, created_at: iso(submittedAt),
    });

    /* ---- the sales funnel ------------------------------------------------- */
    const disqualified = role === 'Mitarbeitende' || horizon === 'nur Information' || employees === 'unter 15';
    const scheduled = !disqualified && chance(0.62);
    const noShow = scheduled && chance(0.22);
    const attended = scheduled && !noShow;
    const passed = attended && chance(0.58);
    const opportunity = passed && chance(0.72);
    const won = opportunity && chance(0.34);
    const lost = opportunity && !won && chance(0.55);

    const vqStatus = !scheduled ? 'NOT_SCHEDULED' : noShow ? 'NO_SHOW' : passed ? 'PASSED' : attended ? 'REJECTED' : 'SCHEDULED';
    const vqScheduledAt = scheduled ? submittedAt + between(1, 5) * DAY : null;
    const vqOccurredAt = attended || noShow ? vqScheduledAt + between(3, 9) * DAY : null;

    const contactExternalId = `hs-contact-${String(leadCounter).padStart(5, '0')}`;
    leads.push({
      id: leadId, workspace_id: WORKSPACE, am_person_id: personId, submission_id: submissionId, campaign_id: campaign.id,
      hubspot_contact_id: contactExternalId, hubspot_company_id: `hs-company-${String(leadCounter).padStart(5, '0')}`,
      sync_status: 'SYNCED', vq_status: vqStatus, vq_score: disqualified ? between(5, 34) : between(45, 96),
      vq_reason_codes: disqualified ? ['ROLE_NOT_DECISION_MAKER', 'HORIZON_INFORMATION_ONLY'] : ['SIZE_FIT', 'RESULT_PRESSURE'],
      vq_model_version: 'vq-2026-03', vq_evaluated_at: iso(submittedAt + 3_600_000),
      vq_scheduled_at: vqScheduledAt ? iso(vqScheduledAt) : null, vq_occurred_at: vqOccurredAt ? iso(vqOccurredAt) : null,
      created_at: iso(submittedAt), updated_at: iso(vqOccurredAt ?? submittedAt),
    });

    const addStage = (type, atMs, extra = {}) =>
      stageEvents.push({
        id: uid('0stage'), workspace_id: WORKSPACE, lead_id: leadId, opportunity_id: extra.opportunity_id ?? null,
        submission_id: submissionId, campaign_id: campaign.id, type, occurred_at: iso(atMs), recorded_at: iso(atMs + 60_000),
        source_object: extra.source_object ?? 'CONTACT', hubspot_object_id: extra.hubspot_object_id ?? contactExternalId,
        previous_state: extra.previous_state ?? null, new_state: type, mapping_version: 1,
        source_event_id: `${contactExternalId}:${type}`, attribution_snapshot_id: snapshotId,
        amount_minor: extra.amount_minor ?? null, currency: extra.amount_minor ? 'EUR' : null, created_at: iso(atMs + 60_000),
      });

    addStage('FORM_COMPLETED', submittedAt, { source_object: 'INTERNAL' });
    if (scheduled) addStage('VQ_SCHEDULED', vqScheduledAt);
    if (noShow) addStage('VQ_NO_SHOW', vqOccurredAt);
    if (attended) addStage('VQ_ATTENDED', vqOccurredAt);
    if (attended && passed) addStage('VQ_PASSED', vqOccurredAt + 3_600_000);
    if (attended && !passed) addStage('VQ_REJECTED', vqOccurredAt + 3_600_000);

    if (opportunity) {
      const opportunityId = uid('0opp');
      const dealExternalId = `hs-deal-${String(leadCounter).padStart(5, '0')}`;
      const createdAt = vqOccurredAt + between(2, 8) * DAY;
      const amount = between(18_000_00, 96_000_00);
      const closedAt = createdAt + between(14, 62) * DAY;
      const isClosed = closedAt < NOW && (won || lost);

      opportunities.push({
        id: opportunityId, workspace_id: WORKSPACE, am_opportunity_id: uid('0amopp'), am_person_id: personId,
        lead_id: leadId, acquisition_submission_id: submissionId, acquisition_snapshot_id: snapshotId,
        campaign_id: campaign.id, hubspot_deal_id: dealExternalId, pipeline: 'default',
        stage: isClosed ? (won ? 'closedwon' : 'closedlost') : 'presentationscheduled',
        amount_minor: amount, currency: 'EUR',
        closed_won_at: isClosed && won ? iso(closedAt) : null,
        closed_lost_at: isClosed && lost ? iso(closedAt) : null,
        closed_lost_reason: isClosed && lost ? pick(['Budget verschoben', 'Interne Umsetzung geplant', 'Kein Entscheidungsdruck']) : null,
        sync_status: 'SYNCED', created_at: iso(createdAt), updated_at: iso(isClosed ? closedAt : createdAt),
      });

      addStage('OPPORTUNITY_CREATED', createdAt, { opportunity_id: opportunityId, source_object: 'DEAL', hubspot_object_id: dealExternalId });
      if (isClosed && won) {
        addStage('CLOSED_WON', closedAt, { opportunity_id: opportunityId, source_object: 'DEAL', hubspot_object_id: dealExternalId, amount_minor: amount });
        revenueEvents.push({ id: uid('0rev'), workspace_id: WORKSPACE, opportunity_id: opportunityId, campaign_id: campaign.id, occurred_at: iso(closedAt), amount_minor: amount, currency: 'EUR', kind: 'BOOKED', reconciliation_delta_minor: null, source_event_id: `${dealExternalId}:booked`, created_at: iso(closedAt) });
        revenueEvents.push({ id: uid('0rev'), workspace_id: WORKSPACE, opportunity_id: opportunityId, campaign_id: campaign.id, occurred_at: iso(closedAt + 30 * DAY), amount_minor: Math.round(amount / 3), currency: 'EUR', kind: 'RECOGNIZED', reconciliation_delta_minor: null, source_event_id: `${dealExternalId}:recognized-1`, created_at: iso(closedAt + 30 * DAY) });
        capiDispatches.push({ id: uid('0capi'), workspace_id: WORKSPACE, outbox_event_id: null, dataset_id: 'DEMO-DATASET', event_name: 'Purchase', event_id: `capi:${opportunityId}:CONVERTED`, capi_stage: 'CONVERTED', event_time: iso(closedAt), action_source: 'website', submission_id: submissionId, lead_id: leadId, opportunity_id: opportunityId, campaign_id: campaign.id, test_event_code: null, request_hash: hash64(`capi:${opportunityId}`), state: 'ACCEPTED', events_received: 1, fbtrace_id: `demo-${opportunityId.slice(-8)}`, response_redacted: { events_received: 1 }, error: null, dispatched_at: iso(closedAt + 120_000), created_at: iso(closedAt), updated_at: iso(closedAt + 120_000) });
      }
      if (isClosed && lost) addStage('CLOSED_LOST', closedAt, { opportunity_id: opportunityId, source_object: 'DEAL', hubspot_object_id: dealExternalId });

      hubspotObjects.push({ id: uid('0hsobj'), workspace_id: WORKSPACE, provider: 'HUBSPOT', external_id: dealExternalId, object_type: 'DEAL', am_person_id: personId, lead_id: leadId, opportunity_id: opportunityId, properties_redacted: { dealname: '[redacted]', pipeline: 'default', amount: String(amount / 100) }, pipeline: 'default', stage: isClosed ? (won ? 'closedwon' : 'closedlost') : 'presentationscheduled', amount_minor: amount, currency: 'EUR', archived: false, last_synced_at: iso(NOW - DAY), provider_updated_at: iso(isClosed ? closedAt : createdAt), created_at: iso(createdAt), updated_at: iso(NOW - DAY) });
      hubspotStages.push({ id: uid('0hsst'), workspace_id: WORKSPACE, hubspot_object_id: null, external_id: dealExternalId, object_type: 'DEAL', pipeline: 'default', from_stage: 'appointmentscheduled', to_stage: isClosed ? (won ? 'closedwon' : 'closedlost') : 'presentationscheduled', occurred_at: iso(isClosed ? closedAt : createdAt), observed_at: iso(NOW - DAY), source: 'POLL', source_event_id: `${dealExternalId}:stage`, mapping_version: 1, lead_stage_event_id: null, created_at: iso(NOW - DAY) });
    }

    hubspotObjects.push({ id: uid('0hsobj'), workspace_id: WORKSPACE, provider: 'HUBSPOT', external_id: contactExternalId, object_type: 'CONTACT', am_person_id: personId, lead_id: leadId, opportunity_id: null, properties_redacted: { email: '[redacted]', firstname: '[redacted]', lastname: '[redacted]', mitarbeiterzahl: employees, jahresumsatz: revenueBand }, pipeline: null, stage: null, amount_minor: null, currency: null, archived: false, last_synced_at: iso(NOW - DAY), provider_updated_at: iso(submittedAt), created_at: iso(submittedAt), updated_at: iso(NOW - DAY) });

    // Outbox + sync attempts. Most succeed; a handful fail on purpose.
    const eventId = `lead:${submissionId}`;
    const flaky = leadCounter % 17 === 0;
    const dead = leadCounter === 34;
    outbox.push({
      id: uid('0outb'), workspace_id: WORKSPACE, destination: 'HUBSPOT', event_id: eventId, dataset_id: '',
      event_name: 'contact.upsert', event_time: iso(submittedAt),
      payload: { objectType: 'CONTACT', properties: { email: '[redacted]', mitarbeiterzahl: employees } },
      payload_hash: hash64(`payload:${submissionId}`),
      status: dead ? 'DEAD_LETTER' : 'ACCEPTED', attempt_count: dead ? 8 : flaky ? 3 : 1,
      next_attempt_at: null,
      last_error: dead ? 'HubSpot 400: property "mitarbeiterzahl" does not exist on object type CONTACT' : flaky ? null : null,
      provider_response_redacted: dead ? { status: 400, category: 'VALIDATION_ERROR' } : { status: 200, id: '[redacted]' },
      sent_at: dead ? null : iso(submittedAt + 4_000), locked_at: null, locked_by: null,
      campaign_id: campaign.id, submission_id: submissionId, lead_id: leadId, opportunity_id: null,
      created_at: iso(submittedAt), updated_at: iso(submittedAt + 4_000),
    });

    if (flaky || dead) {
      const attemptCount = dead ? 3 : 2;
      for (let attempt = 1; attempt <= attemptCount; attempt++) {
        const failing = dead || attempt < attemptCount;
        hubspotAttempts.push({
          id: uid('0hsatt'), workspace_id: WORKSPACE, outbox_event_id: null, submission_id: submissionId, lead_id: leadId,
          opportunity_id: null, object_type: 'CONTACT', operation: 'CREATE', attempt_number: attempt,
          status: dead && attempt === attemptCount ? 'DEAD_LETTER' : failing ? 'FAILED_RETRYING' : 'SYNCED',
          mapping_version: 1, request_hash: hash64(`req:${submissionId}:${attempt}`),
          http_status: failing ? (dead ? 400 : 429) : 200,
          error_code: failing ? (dead ? 'VALIDATION_ERROR' : 'RATE_LIMIT') : null,
          error_message: failing ? (dead ? 'property "mitarbeiterzahl" does not exist on object type CONTACT' : 'You have reached your secondly limit.') : null,
          response_redacted: failing ? { status: dead ? 400 : 429, category: dead ? 'VALIDATION_ERROR' : 'RATE_LIMITS' } : { status: 200, id: '[redacted]' },
          started_at: iso(submittedAt + attempt * 30_000), finished_at: iso(submittedAt + attempt * 30_000 + 800),
          duration_ms: between(180, 900), next_attempt_at: failing ? iso(submittedAt + attempt * 120_000) : null,
          created_at: iso(submittedAt + attempt * 30_000),
        });
      }
    } else {
      hubspotAttempts.push({
        id: uid('0hsatt'), workspace_id: WORKSPACE, outbox_event_id: null, submission_id: submissionId, lead_id: leadId,
        opportunity_id: null, object_type: 'CONTACT', operation: 'CREATE', attempt_number: 1, status: 'SYNCED',
        mapping_version: 1, request_hash: hash64(`req:${submissionId}:1`), http_status: 200, error_code: null,
        error_message: null, response_redacted: { status: 200, id: '[redacted]' },
        started_at: iso(submittedAt + 2_000), finished_at: iso(submittedAt + 2_400), duration_ms: between(120, 600),
        next_attempt_at: null, created_at: iso(submittedAt + 2_000),
      });
    }

    capiDispatches.push({
      id: uid('0capi'), workspace_id: WORKSPACE, outbox_event_id: null, dataset_id: 'DEMO-DATASET', event_name: 'Lead',
      event_id: `lead:${submissionId}`, capi_stage: 'INITIAL_LEAD', event_time: iso(submittedAt), action_source: 'website',
      submission_id: submissionId, lead_id: leadId, opportunity_id: null, campaign_id: campaign.id, test_event_code: null,
      request_hash: hash64(`capi:lead:${submissionId}`), state: 'ACCEPTED', events_received: 1,
      fbtrace_id: `demo-${submissionId.slice(-8)}`, response_redacted: { events_received: 1 }, error: null,
      dispatched_at: iso(submittedAt + 5_000), created_at: iso(submittedAt), updated_at: iso(submittedAt + 5_000),
    });
  }
}

// Session event counters, derived rather than guessed.
const eventCounts = new Map();
for (const event of events) eventCounts.set(event.session_id, (eventCounts.get(event.session_id) ?? 0) + 1);
for (const session of sessions) session.event_count = eventCounts.get(session.id) ?? 0;

insert('visitors', Object.keys(visitors[0]), visitors, { chunkSize: 300 });
insert('sessions', Object.keys(sessions[0]), sessions, { chunkSize: 200 });
insert('touchpoints', Object.keys(touchpoints[0]), touchpoints, { chunkSize: 200 });
insert('form_instances', Object.keys(formInstances[0]), formInstances, { chunkSize: 200 });
insert('events', Object.keys(events[0]), events, { chunkSize: 250 });

/* -------------------------------------------------------------------------- */
/* Experiment assignments and exposures                                        */
/* -------------------------------------------------------------------------- */

const assignments = [];
const exposures = [];
for (const session of sessions) {
  if (!session.experiment_id || !session.experiment_arm_id) continue;
  if (!assignments.some((a) => a.experiment_id === session.experiment_id && a.visitor_id === session.visitor_id)) {
    assignments.push({ id: uid('0assg'), workspace_id: WORKSPACE, experiment_id: session.experiment_id, visitor_id: session.visitor_id, arm_id: session.experiment_arm_id, bucket: Number(rand().toFixed(8)), assigned_at: session.started_at });
  }
  exposures.push({ id: uid('0expo'), workspace_id: WORKSPACE, experiment_id: session.experiment_id, visitor_id: session.visitor_id, session_id: session.id, arm_id: session.experiment_arm_id, exposed_at: session.started_at });
}
insert('experiment_assignments', Object.keys(assignments[0]), assignments, { chunkSize: 300 });
insert('experiment_exposures', Object.keys(exposures[0]), exposures, { chunkSize: 300 });

insert('form_submissions', Object.keys(submissions[0]), submissions.map((s) => ({ ...s, attribution_snapshot_id: null, lead_id: null })), { chunkSize: 100 });
insert('submission_answers_non_pii', Object.keys(answers[0]), answers, { chunkSize: 250 });
say('-- Personal data is present only as ciphertext placeholders: the demo workspace');
say('-- holds no real names, e-mail addresses or phone numbers.');
insert('submission_pii_encrypted', ['id', 'workspace_id', 'submission_id', 'algorithm', 'key_version', 'iv', 'auth_tag', 'ciphertext', 'email_hash', 'phone_hash', 'email_domain', 'created_at'],
  piiRows.map((row) => ({ ...row, iv: { __raw: `decode('${Buffer.from(row.iv).toString('base64')}', 'base64')` }, auth_tag: { __raw: `decode('${Buffer.from(row.auth_tag).toString('base64')}', 'base64')` }, ciphertext: { __raw: `decode('${Buffer.from(row.ciphertext).toString('base64')}', 'base64')` } })),
  { chunkSize: 100 });
insert('submission_status_history', Object.keys(statusHistory[0]), statusHistory, { chunkSize: 250 });
insert('attribution_snapshots', Object.keys(snapshots[0]), snapshots, { chunkSize: 100 });
insert('leads', Object.keys(leads[0]), leads, { chunkSize: 100 });
say(`update public.form_submissions fs set attribution_snapshot_id = s.id from public.attribution_snapshots s where s.submission_id = fs.id;`);
say(`update public.form_submissions fs set lead_id = l.id from public.leads l where l.submission_id = fs.id;`);
say();
insert('opportunities', Object.keys(opportunities[0]), opportunities, { chunkSize: 100 });
insert('lead_stage_events', Object.keys(stageEvents[0]), stageEvents, { chunkSize: 200 });
insert('revenue_events', Object.keys(revenueEvents[0]), revenueEvents, { chunkSize: 100 });

/* -------------------------------------------------------------------------- */
/* HubSpot mapping, integrations, outbox, recommendations, learnings, audit     */
/* -------------------------------------------------------------------------- */

insert(
  'hubspot_mappings',
  ['id', 'workspace_id', 'object_type', 'version', 'state', 'field_map', 'stage_map', 'pipeline_id', 'pipeline_label', 'required_fields', 'missing_fields', 'content_hash', 'published_at', 'published_by', 'created_by'],
  [
    { id: uid('0hsmap'), workspace_id: WORKSPACE, object_type: 'CONTACT', version: 1, state: 'PUBLISHED', field_map: { email: { hubspot_property: 'email', required: true }, vorname: { hubspot_property: 'firstname', required: true }, nachname: { hubspot_property: 'lastname', required: true }, telefon: { hubspot_property: 'phone', required: false }, mitarbeiterzahl: { hubspot_property: 'am_mitarbeiterzahl', required: true } }, stage_map: {}, pipeline_id: null, pipeline_label: null, required_fields: ['email', 'vorname', 'nachname', 'mitarbeiterzahl'], missing_fields: [], content_hash: hash64('hsmap:contact'), published_at: iso(NOW - 520 * DAY), published_by: PROFILES.revops, created_by: PROFILES.revops },
    { id: uid('0hsmap'), workspace_id: WORKSPACE, object_type: 'COMPANY', version: 1, state: 'PUBLISHED', field_map: { firmenname: { hubspot_property: 'name', required: true }, branche: { hubspot_property: 'industry', required: false } }, stage_map: {}, pipeline_id: null, pipeline_label: null, required_fields: ['firmenname'], missing_fields: [], content_hash: hash64('hsmap:company'), published_at: iso(NOW - 520 * DAY), published_by: PROFILES.revops, created_by: PROFILES.revops },
    { id: uid('0hsmap'), workspace_id: WORKSPACE, object_type: 'DEAL', version: 1, state: 'PUBLISHED', field_map: { dealname: { hubspot_property: 'dealname', required: true }, betrag: { hubspot_property: 'amount', required: false } }, stage_map: { appointmentscheduled: 'VQ_SCHEDULED', presentationscheduled: 'OPPORTUNITY_CREATED', closedwon: 'CLOSED_WON', closedlost: 'CLOSED_LOST' }, pipeline_id: 'default', pipeline_label: 'Vertriebspipeline', required_fields: ['dealname'], missing_fields: [], content_hash: hash64('hsmap:deal'), published_at: iso(NOW - 520 * DAY), published_by: PROFILES.revops, created_by: PROFILES.revops },
  ],
);

insert('hubspot_objects', Object.keys(hubspotObjects[0]), hubspotObjects, { chunkSize: 150 });
insert('hubspot_sync_attempts', Object.keys(hubspotAttempts[0]), hubspotAttempts, { chunkSize: 150 });
if (hubspotStages.length) insert('hubspot_stage_history', Object.keys(hubspotStages[0]), hubspotStages, { chunkSize: 150 });

insert('outbox_events', Object.keys(outbox[0]), outbox, { chunkSize: 100 });
insert('capi_dispatches', Object.keys(capiDispatches[0]), capiDispatches, { chunkSize: 100 });

insert(
  'integration_connections',
  ['id', 'workspace_id', 'provider', 'state', 'account_label', 'external_account_id', 'granted_scopes', 'last_checked_at', 'last_error', 'created_by'],
  [
    { id: uid('0conn'), workspace_id: WORKSPACE, provider: 'META', state: 'FIXTURE', account_label: 'A&M Unternehmerberatung (Fixture)', external_account_id: 'act_100000000000001', granted_scopes: [], last_checked_at: iso(NOW - 3_600_000), last_error: null, created_by: PROFILES.admin },
    { id: uid('0conn'), workspace_id: WORKSPACE, provider: 'HUBSPOT', state: 'FIXTURE', account_label: 'A&M CRM (Fixture)', external_account_id: null, granted_scopes: [], last_checked_at: iso(NOW - 3_600_000), last_error: null, created_by: PROFILES.admin },
    { id: uid('0conn'), workspace_id: WORKSPACE, provider: 'OPENAI', state: 'FIXTURE', account_label: 'Fixture-Provider', external_account_id: null, granted_scopes: [], last_checked_at: iso(NOW - 3_600_000), last_error: null, created_by: PROFILES.admin },
  ],
);

insert(
  'integration_health_checks',
  ['id', 'workspace_id', 'provider', 'key', 'label_de', 'status', 'detail_de', 'remediation_de', 'blocks_live_only', 'checked_at'],
  [
    { id: uid('0hchk'), workspace_id: WORKSPACE, provider: 'META', key: 'meta_permissions_valid', label_de: 'Meta-Berechtigungen gültig', status: 'AWAITING_EXTERNAL_INPUT', detail_de: 'Es ist kein Meta-Access-Token hinterlegt; das Produkt arbeitet gegen Fixtures.', remediation_de: 'META_ACCESS_TOKEN und META_AD_ACCOUNT_ID in den Einstellungen hinterlegen.', blocks_live_only: true, checked_at: iso(NOW - 3_600_000) },
    { id: uid('0hchk'), workspace_id: WORKSPACE, provider: 'META', key: 'pixel_capi_dedup_tested', label_de: 'Pixel/CAPI-Deduplizierung getestet', status: 'AWAITING_EXTERNAL_INPUT', detail_de: 'Ohne Dataset-ID kann die Deduplizierung nicht verifiziert werden.', remediation_de: 'META_DATASET_ID hinterlegen und Testereignis senden.', blocks_live_only: true, checked_at: iso(NOW - 3_600_000) },
    { id: uid('0hchk'), workspace_id: WORKSPACE, provider: 'HUBSPOT', key: 'hubspot_mapping_complete', label_de: 'HubSpot-Pflichtmapping vollständig', status: 'PASS', detail_de: 'Alle Pflichtfelder für Contact, Company und Deal sind gemappt.', remediation_de: null, blocks_live_only: true, checked_at: iso(NOW - 3_600_000) },
    { id: uid('0hchk'), workspace_id: WORKSPACE, provider: 'HUBSPOT', key: 'no_critical_sync_errors', label_de: 'Keine kritischen Syncfehler', status: 'WARN', detail_de: 'Ein Lead liegt im Dead-Letter, weil die Property "mitarbeiterzahl" im Ziel-Portal fehlt.', remediation_de: 'Property in HubSpot anlegen und den Dead-Letter-Eintrag erneut einreihen.', blocks_live_only: false, checked_at: iso(NOW - 3_600_000) },
    { id: uid('0hchk'), workspace_id: WORKSPACE, provider: 'OPENAI', key: 'model_available', label_de: 'Modell erreichbar', status: 'AWAITING_EXTERNAL_INPUT', detail_de: 'Kein OPENAI_API_KEY gesetzt; Generierung läuft gegen Fixtures.', remediation_de: 'OPENAI_API_KEY hinterlegen.', blocks_live_only: false, checked_at: iso(NOW - 3_600_000) },
  ],
);

insert(
  'sync_cursors',
  ['id', 'workspace_id', 'provider', 'resource', 'cursor_value', 'cursor_time', 'last_run_at', 'last_success_at', 'last_error', 'consecutive_failures'],
  [
    { id: uid('0curs'), workspace_id: WORKSPACE, provider: 'META', resource: 'insights_daily', cursor_value: day(NOW - DAY), cursor_time: iso(NOW - DAY), last_run_at: iso(NOW - 3_600_000), last_success_at: iso(NOW - 3_600_000), last_error: null, consecutive_failures: 0 },
    { id: uid('0curs'), workspace_id: WORKSPACE, provider: 'HUBSPOT', resource: 'deals', cursor_value: String(NOW - 2 * DAY), cursor_time: iso(NOW - 2 * DAY), last_run_at: iso(NOW - 7_200_000), last_success_at: iso(NOW - 7_200_000), last_error: null, consecutive_failures: 0 },
  ],
);

const liveCampaign = campaigns[campaigns.length - 1];
insert(
  'recommendations',
  ['id', 'workspace_id', 'campaign_id', 'experiment_id', 'action', 'state', 'rule_id', 'dedup_key', 'title_de', 'summary_de', 'explanation_de', 'next_hypothesis_de', 'facts', 'comparison_basis_de', 'maturity', 'attribution_coverage', 'uncertainty_de', 'risk', 'risk_note_de', 'affected_meta_objects', 'proposed_budget_change_pct', 'created_by'],
  [
    {
      id: uid('0rec'), workspace_id: WORKSPACE, campaign_id: liveCampaign.id, experiment_id: null,
      action: 'PAUSE_CREATIVE', state: 'OPEN', rule_id: 'PAUSE_NO_LEAD_ABOVE_1_5X_TARGET_CPL', dedup_key: 'concept_5',
      title_de: 'Creative „concept_5“ pausieren', summary_de: 'Concept 5 hat 412,00 EUR ausgegeben und dabei keinen Lead erzeugt. Das entspricht dem 7,6-fachen des Ziel-CPL von 54,00 EUR.',
      explanation_de: 'Die Bildsprache dieses Konzepts unterscheidet sich stark von den übrigen fünf; möglicherweise wird die Zielgruppe nicht als angesprochen erkannt.',
      next_hypothesis_de: 'Ein Motiv mit erkennbarem Betriebskontext könnte die Formularstartrate wieder auf das Niveau der übrigen Konzepte heben.',
      facts: J([{ metric: 'spend', label: 'Ausgaben', numerator: null, denominator: null, value: 41200, currency: 'EUR', comparisonLabel: 'Ziel-CPL', comparisonValue: 5400 }, { metric: 'leads', label: 'Leads', numerator: 0, denominator: 412, value: 0, currency: null, comparisonLabel: null, comparisonValue: null }]),
      comparison_basis_de: 'Ziel-CPL der Kampagne, letzte 14 Tage', maturity: 'PARTIAL', attribution_coverage: 0.86,
      uncertainty_de: 'Bei null Leads ist kein Konfidenzintervall berechenbar; die Aussage stützt sich auf die Ausgabenhöhe.',
      risk: 'LOW', risk_note_de: 'Das Pausieren eines Creatives ist reversibel und betrifft kein Budget auf Kampagnenebene.',
      affected_meta_objects: J([{ level: 'AD', external_id: metaAds[metaAds.length - 1].external_id, name: metaAds[metaAds.length - 1].name, currentStatus: 'ACTIVE', currentDailyBudgetMinor: null, proposedDailyBudgetMinor: null }]),
      proposed_budget_change_pct: null, created_by: null,
    },
    {
      id: uid('0rec'), workspace_id: WORKSPACE, campaign_id: liveCampaign.id, experiment_id: null,
      action: 'COLLECT_MORE_DATA', state: 'OPEN', rule_id: 'CRM_IMMATURE_BLOCK_SCALE', dedup_key: 'crm-maturity',
      title_de: 'Vor der Skalierung CRM-Reife abwarten', summary_de: 'Von 21 Leads sind 6 älter als 21 Tage. Die CRM-Kohorte ist damit noch nicht reif genug für eine Budgetentscheidung.',
      explanation_de: null, next_hypothesis_de: null,
      facts: J([{ metric: 'leads', label: 'Reife Leads', numerator: 6, denominator: 21, value: 0.2857, currency: null, comparisonLabel: 'Schwelle', comparisonValue: 21 }]),
      comparison_basis_de: 'CRM-Reifegrenze aus den Einstellungen (21 Tage)', maturity: 'IMMATURE', attribution_coverage: 0.86,
      uncertainty_de: 'Datenbasis zu klein für eine belastbare Aussage zu Kosten je qualifiziertem VQ.',
      risk: 'MEDIUM', risk_note_de: 'Eine Skalierung auf Basis unreifer Daten kann den Cost-per-Qualified-VQ dauerhaft verschlechtern.',
      affected_meta_objects: J([]), proposed_budget_change_pct: null, created_by: null,
    },
  ],
);

const learningCards = campaigns.slice(0, 5).map((campaign, index) => ({
  id: uid('0learn'), workspace_id: WORKSPACE, version: 1, campaign_id: campaign.id,
  experiment_id: campaign.experiment ? campaign.experiment.id : null,
  title_de: `${campaign.name}: ${campaign.name.includes('Benchmark') ? 'Vergleichslogik schlägt Nutzenversprechen' : 'Konkrete Zahl schlägt Problemzuspitzung'}`,
  what_was_tested_de: `Getestet wurde der Angle „${angles[index].name}“ gegen die im Vorquartal genutzte Ansprache, bei identischem Offer und identischer Zielgruppe.`,
  angle_id: campaign.angle_id, angle_name: angles[index].name, offer_id: campaign.offer_id,
  offer_name: OFFERS.find((o) => o.id === campaign.offer_id).name,
  creative_concept_de: 'Sechs Konzepte entlang der sechs Kommunikationsprinzipien, fünf davon freigegeben.',
  funnel_kind: 'MULTI_STEP_FORM', audience_de: ICPS[index % ICPS.length].name,
  period_start: campaign.launched_at, period_end: campaign.completed_at,
  spend_minor: campaign.test_budget_minor, currency: 'EUR',
  outcome_de: 'Die Kampagne erreichte ihren Ziel-CPL, blieb aber bei den Kosten je qualifiziertem VQ über dem Ziel.',
  outcome_facts: J([{ label: 'CPL', numerator: null, denominator: null, value: campaign.target_cpl_minor / 100, unit: 'EUR' }, { label: 'Qualifizierungsrate', numerator: 7, denominator: 19, value: 0.368, unit: null }]),
  data_maturity: 'MATURE', attribution_level: 'REVENUE_LINKED', attribution_coverage: Number((0.82 + rand() * 0.14).toFixed(4)),
  possible_explanation_de: 'Die stärkere Qualifizierungstiefe reduziert die Lead-Menge, hebt aber den Anteil entscheidungsbefugter Kontakte.',
  suggested_next_test_de: 'Denselben Angle mit einem Benchmark-Offer statt der Potenzialanalyse testen.',
  confidence: 'INDICATION', created_by: PROFILES.lead,
}));
insert('learning_cards', Object.keys(learningCards[0]), learningCards);

const auditRows = [];
for (const campaign of campaigns) {
  auditRows.push(
    { id: uid('0aud'), workspace_id: WORKSPACE, action: 'campaign.created', occurred_at: campaign.created_at, actor_id: PROFILES.operator, actor_label: 'Marketing Operator', entity_type: 'campaign', entity_id: campaign.id, campaign_id: campaign.id, summary_de: `Kampagne „${campaign.name}“ angelegt.`, before: null, after: null, correlation_id: null },
    { id: uid('0aud'), workspace_id: WORKSPACE, action: 'proposal.generated', occurred_at: campaign.created_at, actor_id: null, actor_label: 'ai-pipeline', entity_type: 'campaign_proposal', entity_id: campaign.id, campaign_id: campaign.id, summary_de: 'Kampagnenvorschlag mit sechs Creative-Konzepten und drei Funnel-Varianten erzeugt.', before: null, after: null, correlation_id: null },
    { id: uid('0aud'), workspace_id: WORKSPACE, action: 'approval.granted', occurred_at: campaign.launched_at, actor_id: PROFILES.lead, actor_label: 'Marketing Lead', entity_type: 'approval', entity_id: campaign.id, campaign_id: campaign.id, summary_de: 'Strategie, Assets, Testplan und Veröffentlichung freigegeben.', before: null, after: null, correlation_id: null },
    { id: uid('0aud'), workspace_id: WORKSPACE, action: 'campaign.state_changed', occurred_at: campaign.launched_at, actor_id: PROFILES.lead, actor_label: 'Marketing Lead', entity_type: 'campaign', entity_id: campaign.id, campaign_id: campaign.id, summary_de: `Status auf ${campaign.state} geändert.`, before: { state: 'READY_FOR_META_DRAFT' }, after: { state: campaign.state }, correlation_id: null },
  );
}
auditRows.push({ id: uid('0aud'), workspace_id: WORKSPACE, action: 'hubspot.sync_failed', occurred_at: iso(NOW - 40 * DAY), actor_id: null, actor_label: 'hubspot-sync', entity_type: 'outbox_event', entity_id: outbox[33] ? outbox[33].id : outbox[0].id, campaign_id: null, summary_de: 'HubSpot-Sync nach acht Versuchen ins Dead-Letter verschoben: Property "mitarbeiterzahl" fehlt im Portal.', before: null, after: null, correlation_id: null });
auditRows.push({ id: uid('0aud'), workspace_id: WORKSPACE, action: 'meta.import_completed', occurred_at: iso(NOW - DAY), actor_id: null, actor_label: 'meta-import', entity_type: 'meta_account', entity_id: META_ACCOUNT, campaign_id: null, summary_de: `Historischer Import abgeschlossen: ${insights.length} Insight-Zeilen über 18 Monate.`, before: null, after: null, correlation_id: null });
insert('audit_logs', Object.keys(auditRows[0]), auditRows, { chunkSize: 100 });

say('commit;');
say();
say('-- --------------------------------------------------------------------------');
say(`-- Generated ${campaigns.length} campaigns, ${concepts.length} creative concepts, ${funnels.length} funnels,`);
say(`-- ${experiments.length} concluded experiments, ${sessions.length} sessions, ${events.length} events,`);
say(`-- ${submissions.length} submissions, ${leads.length} leads, ${opportunities.length} opportunities,`);
say(`-- ${revenueEvents.length} revenue events, ${insights.length} daily Meta insight rows.`);
say('-- --------------------------------------------------------------------------');

/* -------------------------------------------------------------------------- */
/* Emit                                                                        */
/* -------------------------------------------------------------------------- */

const sql = chunks.join('\n');

writeFileSync(OUT, sql + '\n', 'utf8');
process.stdout.write(
  `seed.sql written: ${(sql.length / 1024 / 1024).toFixed(2)} MB, ` +
    `${campaigns.length} campaigns, ${sessions.length} sessions, ${events.length} events, ` +
    `${submissions.length} submissions, ${leads.length} leads, ${insights.length} insight rows\n`,
);
