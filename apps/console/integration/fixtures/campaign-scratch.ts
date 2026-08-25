import { createSupabaseDatabase, type AmDatabase, type DbClient } from '@am/db';
import {
  assetsContentHash,
  publishContentHash,
  strategyContentHash,
  testPlanContentHash,
} from '@/server/campaign-content-hash';
import { withTransaction, type TransactionRunner } from '@/server/campaign-transaction';
import { createPostgrestOverPg, type PgConnectionLike } from './postgrest-over-pg';

/**
 * A small, deliberate dataset for the Campaign Room integration tests.
 *
 * Not `supabase/seed/seed.sql`: that file is five megabytes of eighteen months
 * of demo history, and a test that asserts against it asserts against whatever
 * the generator happened to produce. This is the opposite — every row is here
 * because a test reads it, and every field a test compares against is written
 * from a named constant.
 *
 * Two workspaces, four people, and one campaign per workspace, so a test can ask
 * the one question a single-tenant fixture cannot answer: what does an operator
 * of workspace A see when they ask for a campaign of workspace B?
 */

export const WORKSPACE_A = '0a11b0a1-0000-4000-8000-0000000000a1';
export const WORKSPACE_B = '0a11b0a1-0000-4000-8000-0000000000b1';

export const PROFILE_ADMIN = '0aaa0001-0000-4000-8000-0000000000a1';
export const PROFILE_LEAD = '0aaa0001-0000-4000-8000-0000000000a2';
/** MARKETING_OPERATOR: may edit a campaign, may not approve a strategy. */
export const PROFILE_OPERATOR = '0aaa0001-0000-4000-8000-0000000000a3';
/** Member of workspace B only. */
export const PROFILE_OUTSIDER = '0aaa0001-0000-4000-8000-0000000000b2';

export const CAMPAIGN_A = 'caa9d0a1-0000-4000-8000-0000000000a1';
export const CAMPAIGN_B = 'caa9d0b1-0000-4000-8000-0000000000b1';

export const CAMPAIGN_A_NAME = 'Potenzialanalyse Handwerk — Q3';
export const CAMPAIGN_A_SLUG = 'potenzialanalyse-handwerk-q3';
export const ANGLE_NAME = 'Planbare Anfragen statt Empfehlungsglück';
export const OFFER_NAME = 'Kostenlose Potenzialanalyse';
export const CORE_MESSAGE =
  'Wer die Qualifizierung vor den Termin zieht, bekommt planbare Auslastung statt zufälliger Empfehlungen.';
export const AUDIENCE_NAME = 'Geschäftsführung Handwerk, 20–80 Mitarbeitende';
export const DAILY_BUDGET_MINOR = 12_000;

const AUDIENCE_A = '04e96709-0000-4000-8000-0000000000a1';
const OFFER_A = '0ffe4001-0000-4000-8000-0000000000a1';
const VERSION_A = '7e751041-0000-4000-8000-0000000000a1';
const EXPERIMENT_A = 'e8be4144-0000-4000-8000-0000000000a1';

/** Six concepts, five approved — the launch threshold, met exactly. */
const CONCEPT_KEYS = ['concept_1', 'concept_2', 'concept_3', 'concept_4', 'concept_5', 'concept_6'];
const APPROVED_CONCEPT_KEYS = CONCEPT_KEYS.slice(0, 5);
const FUNNEL_KEYS = ['funnel_1', 'funnel_2', 'funnel_3'];
const FUNNEL_KINDS = ['MULTI_STEP_FORM', 'MULTI_STEP_FORM', 'LANDING_PAGE'];

function conceptId(index: number): string {
  return `c0f9ce71-0000-4000-8000-00000000${String(index).padStart(4, '0')}`;
}

function funnelId(index: number): string {
  return `f0f9e101-0000-4000-8000-00000000${String(index).padStart(4, '0')}`;
}

function funnelVersionId(index: number): string {
  return `f0f9e102-0000-4000-8000-00000000${String(index).padStart(4, '0')}`;
}

function hash64(seed: string): string {
  let out = '';
  let state = 2_166_136_261;
  for (let i = 0; i < 8; i += 1) {
    for (const char of `${i}:${seed}`) {
      state ^= char.charCodeAt(0);
      state = Math.imul(state, 16_777_619);
    }
    out += (state >>> 0).toString(16).padStart(8, '0');
  }
  return out;
}

/** The hash the STRATEGY approval of campaign A is granted against. */
export function strategyHashOfCampaignA(): string {
  // The campaign carries no angle_version_id / offer_version_id, so the port
  // falls back to the names in the published version spec.
  return strategyContentHash({
    angle: ANGLE_NAME,
    offer: OFFER_NAME,
    claims: [],
    coreMessage: CORE_MESSAGE,
    versionHash: hash64('campaign-version:a:1'),
  });
}

export function assetsHashOfCampaignA(): string {
  return assetsContentHash({ creatives: APPROVED_CONCEPT_KEYS, funnels: FUNNEL_KEYS });
}

export function testPlanHashOfCampaignA(): string {
  return testPlanContentHash({ plan: EXPERIMENT_A, dailyBudgetMinor: DAILY_BUDGET_MINOR });
}

export function publishHashOfCampaignA(): string {
  return publishContentHash({ publish: CAMPAIGN_A_SLUG });
}

const COPY = {
  primaryText:
    'Ihre Auslastung schwankt zwischen zwei Großaufträgen — und die nächste Anfrage kommt, wann sie will.',
  headline: 'Planbare Anfragen',
  description: 'In zwei Minuten zur Einschätzung',
  callToAction: 'Mehr erfahren',
};

/**
 * Writes the dataset with owner privileges. Runs before any test drops to
 * `authenticated`, so the rows exist regardless of the policies under test.
 */
export async function seedCampaignScratch(admin: PgConnectionLike): Promise<void> {
  // Workspace A carries the console's own slug, so the port resolves it the way
  // it would in production instead of being handed the right id by the test.
  await admin.query(
    `insert into public.workspaces (id, slug, name) values
       ($1, 'am', 'A&M Workspace A'),
       ($2, 'am-b', 'A&M Workspace B')`,
    [WORKSPACE_A, WORKSPACE_B],
  );

  // `0002_core.sql` links profiles to `auth.users` when that table exists, which
  // it does on any instance carrying the Supabase shim.
  await admin.query(
    `do $auth$
     begin
       if to_regclass('auth.users') is not null then
         insert into auth.users (id, email) values
           ('${PROFILE_ADMIN}',    'admin@am-beratung.de'),
           ('${PROFILE_LEAD}',     'lead@am-beratung.de'),
           ('${PROFILE_OPERATOR}', 'operator@am-beratung.de'),
           ('${PROFILE_OUTSIDER}', 'outsider@am-beratung.de')
         on conflict (id) do nothing;
       end if;
     end
     $auth$;`,
  );

  await admin.query(
    `insert into public.profiles (id, email, display_name) values
       ($1, 'admin@am-beratung.de',    'Admin'),
       ($2, 'lead@am-beratung.de',     'Marketing Lead'),
       ($3, 'operator@am-beratung.de', 'Marketing Operator'),
       ($4, 'outsider@am-beratung.de', 'Fremde Person')`,
    [PROFILE_ADMIN, PROFILE_LEAD, PROFILE_OPERATOR, PROFILE_OUTSIDER],
  );

  await admin.query(
    `insert into public.workspace_members (workspace_id, profile_id, roles) values
       ($1, $3, array['ADMIN']::text[]),
       ($1, $4, array['MARKETING_LEAD']::text[]),
       ($1, $5, array['MARKETING_OPERATOR']::text[]),
       ($2, $6, array['ADMIN']::text[])`,
    [WORKSPACE_A, WORKSPACE_B, PROFILE_ADMIN, PROFILE_LEAD, PROFILE_OPERATOR, PROFILE_OUTSIDER],
  );

  await admin.query(
    `insert into public.workspace_settings (workspace_id, experiment_thresholds) values
       ($1, $2::jsonb), ($3, '{}'::jsonb)`,
    [
      WORKSPACE_A,
      JSON.stringify({
        minRuntimeDays: 14,
        maxRuntimeDays: 35,
        minSessionsPerArm: 200,
        minConversionsPerArm: 20,
        crmMaturityDays: 21,
      }),
      WORKSPACE_B,
    ],
  );

  await admin.query(
    `insert into public.audience_segments
       (id, workspace_id, name, description, company_size, industries, roles, pain_points)
     values ($1, $2, $3, $4, '20–80 Mitarbeitende',
             array['Elektro','Sanitär']::text[],
             array['Geschäftsführung']::text[],
             array['Auslastung schwankt unvorhersehbar zwischen Großaufträgen.']::text[])`,
    [
      AUDIENCE_A,
      WORKSPACE_A,
      AUDIENCE_NAME,
      'Inhabergeführte Handwerksbetriebe mit 20 bis 80 Mitarbeitenden in Deutschland.',
    ],
  );

  await admin.query(
    `insert into public.offers (id, workspace_id, name, offer_type) values ($1, $2, $3, 'POTENTIAL_ANALYSIS')`,
    [OFFER_A, WORKSPACE_A, OFFER_NAME],
  );

  await admin.query(
    `insert into public.evidence_items (workspace_id, kind, statement, source, approved, approved_at)
     values ($1, 'HISTORICAL_PERFORMANCE', $2, 'evidence/auswertung-42-erstgespraeche', true, now())`,
    [WORKSPACE_A, 'Auswertung von 42 Erstgesprächen aus 01/2026 bis 05/2026.'],
  );

  for (const [workspaceId, campaignId, name, slug] of [
    [WORKSPACE_A, CAMPAIGN_A, CAMPAIGN_A_NAME, CAMPAIGN_A_SLUG],
    [WORKSPACE_B, CAMPAIGN_B, 'Kampagne aus Workspace B', 'kampagne-workspace-b'],
  ] as const) {
    await admin.query(
      `insert into public.campaigns
         (id, workspace_id, name, slug, state, audience_segment_id, offer_id, core_message,
          hypothesis, currency, daily_budget_minor, test_budget_minor, target_cpl_minor,
          primary_metric, attribution_level)
       values ($1, $2, $3, $4, 'TEST_PLAN_REVIEW', $5, $6, $7, $8, 'EUR', $9, $10, 2200, 'cpl', 'LEAD_LINKED')`,
      [
        campaignId,
        workspaceId,
        name,
        slug,
        workspaceId === WORKSPACE_A ? AUDIENCE_A : null,
        workspaceId === WORKSPACE_A ? OFFER_A : null,
        CORE_MESSAGE,
        'Wenn die Qualifizierung vor den Termin gezogen wird, sinken die Kosten je qualifiziertem VQ.',
        DAILY_BUDGET_MINOR,
        DAILY_BUDGET_MINOR * 14,
      ],
    );
  }

  await admin.query(
    `insert into public.campaign_versions
       (id, workspace_id, campaign_id, version, state, spec, content_hash, notes, published_at)
     values ($1, $2, $3, 1, 'PUBLISHED', $4::jsonb, $5, $6, now())`,
    [
      VERSION_A,
      WORKSPACE_A,
      CAMPAIGN_A,
      JSON.stringify({
        campaignName: CAMPAIGN_A_NAME,
        angle: ANGLE_NAME,
        offer: OFFER_NAME,
        audience: AUDIENCE_NAME,
        dailyBudgetMinor: DAILY_BUDGET_MINOR,
        budgetRationale:
          'Das Tagesbudget ist so gewählt, dass jeder Arm in 14 Tagen 200 Sessions erreichen kann.',
      }),
      hash64('campaign-version:a:1'),
      'Erste veröffentlichte Fassung aus dem Kampagnenvorschlag.',
    ],
  );
  await admin.query(`update public.campaigns set current_version_id = $1 where id = $2`, [
    VERSION_A,
    CAMPAIGN_A,
  ]);

  await admin.query(
    `insert into public.campaign_proposals
       (workspace_id, campaign_id, model, generation_index, proposal, content_hash,
        similar_campaigns, accepted, accepted_at)
     values ($1, $2, 'fixture', 1, $3::jsonb, $4, $5::jsonb, true, now())`,
    [
      WORKSPACE_A,
      CAMPAIGN_A,
      JSON.stringify({
        angle: {
          name: ANGLE_NAME,
          perspective: 'Auslastung ist kein Vertriebsproblem, sondern ein Planbarkeitsproblem.',
          rationale: 'Die Zielgruppe erlebt Auslastungsschwankungen als konkretes Risiko.',
        },
        offer: {
          name: OFFER_NAME,
          valueExchange: 'Sechs Angaben zum Betrieb gegen eine belastbare Spannbreite.',
          deliverable: 'Einordnung mit Spannbreite und konkretem nächsten Schritt.',
          effortPromise: '2 Minuten',
          qualificationIntent: 'Betriebsgröße, Anfrageweg und Entscheidungsbefugnis vorab erheben.',
        },
        risks: ['Sechs Qualifizierungsfragen können die Submission-Rate stärker senken als erwartet.'],
        differentiationFromPast: 'Der Q1-Angle argumentierte über Wachstum, dieser über Planbarkeit.',
      }),
      hash64('proposal:a'),
      JSON.stringify([
        {
          campaignId: CAMPAIGN_B,
          campaignName: 'Kampagne aus Workspace B',
          similarity: 0.64,
          ranAt: '2026-04-11',
          outcomeSummary: 'CPL 22,10 €.',
          attributionLevel: 'REVENUE_LINKED',
        },
      ]),
    ],
  );

  for (const [index, key] of CONCEPT_KEYS.entries()) {
    const approved = APPROVED_CONCEPT_KEYS.includes(key);
    await admin.query(
      `insert into public.creative_concepts
         (id, workspace_id, campaign_id, concept_key, name, principle, visual_idea, image_prompt,
          copy, hypothesis, rationale, funnel_promise, alt_text, review_state, reviewed_by,
          reviewed_at, diversity_hash, sort_order)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [
        conceptId(index),
        WORKSPACE_A,
        CAMPAIGN_A,
        key,
        `Konzept ${index + 1}`,
        'PROBLEM_PAIN',
        'Werkstatt bei Feierabend, ein Auftragsbuch mit einer Lücke.',
        'Fotografische Aufnahme einer Werkstatt in der blauen Stunde, ohne Text.',
        JSON.stringify(COPY),
        'Das Problem wird erkannt, bevor die Lösung genannt wird.',
        'Der Aufhänger benennt das Risiko statt der Chance.',
        'Eine belastbare Einschätzung in zwei Minuten.',
        'Werkstatt in der blauen Stunde mit einem offenen Auftragsbuch.',
        approved ? 'APPROVED' : 'IN_REVIEW',
        approved ? PROFILE_LEAD : null,
        approved ? new Date('2026-08-20T09:00:00.000Z').toISOString() : null,
        hash64(`diversity:${key}`),
        index,
      ],
    );
  }

  for (const [index, key] of FUNNEL_KEYS.entries()) {
    await admin.query(
      `insert into public.funnels
         (id, workspace_id, campaign_id, funnel_key, kind, name, promise, hypothesis, rationale)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        funnelId(index),
        WORKSPACE_A,
        CAMPAIGN_A,
        key,
        FUNNEL_KINDS[index],
        `Funnel ${index + 1}`,
        'Eine belastbare Einschätzung in zwei Minuten.',
        'Mehr Qualifizierung vor dem Termin senkt die No-Show-Quote.',
        'Die Qualifizierung wird vor die Kontaktabfrage gezogen.',
      ],
    );
    await admin.query(
      `insert into public.funnel_versions
         (id, workspace_id, funnel_id, campaign_id, version, state, spec, content_hash, published_at)
       values ($1, $2, $3, $4, 1, $5, $6::jsonb, $7, $8)`,
      [
        funnelVersionId(index),
        WORKSPACE_A,
        funnelId(index),
        CAMPAIGN_A,
        index === 2 ? 'DRAFT' : 'PUBLISHED',
        JSON.stringify({ kind: FUNNEL_KINDS[index], qualificationQuestionCount: 5 }),
        hash64(`funnel-version:${key}`),
        index === 2 ? null : new Date('2026-08-21T09:00:00.000Z').toISOString(),
      ],
    );
    await admin.query(`update public.funnels set current_version_id = $1 where id = $2`, [
      funnelVersionId(index),
      funnelId(index),
    ]);
  }

  await admin.query(
    `insert into public.published_funnels
       (workspace_id, campaign_id, funnel_id, funnel_version_id, public_slug, path, is_live, environment)
     values ($1, $2, $3, $4, 'potenzialanalyse-a', '/f/potenzialanalyse-a', true, 'production')`,
    [WORKSPACE_A, CAMPAIGN_A, funnelId(0), funnelVersionId(0)],
  );

  await admin.query(
    `insert into public.experiments
       (id, workspace_id, campaign_id, kind, state, name, hypothesis, test_variable,
        primary_metric, secondary_metrics, guardrail_metrics, thresholds, assignment_salt, bundled)
     values ($1, $2, $3, 'BUNDLED_FUNNEL_TEST', 'READY', 'Funnel-Bündeltest',
             $4, 'Anzahl der Qualifizierungsfragen', 'cost_per_qualified_vq',
             array['submission_rate','cpl']::text[], array['ctr','show_rate']::text[],
             $5::jsonb, 'salt-am-2026', true)`,
    [
      EXPERIMENT_A,
      WORKSPACE_A,
      CAMPAIGN_A,
      'Wenn die Qualifizierung vor den Termin gezogen wird, sinken die Kosten je qualifiziertem VQ.',
      JSON.stringify({
        minRuntimeDays: 14,
        maxRuntimeDays: 35,
        minSessionsPerArm: 200,
        minConversionsPerArm: 20,
        crmMaturityDays: 21,
        stopRules: ['Sofort stoppen, wenn ein Arm die Guardrail der Submission-Rate unterschreitet.'],
        scaleRules: ['Maximal 20 % Erhöhung je Aktion, höchstens einmal in 24 Stunden.'],
      }),
    ],
  );

  for (const [index, key] of FUNNEL_KEYS.entries()) {
    await admin.query(
      `insert into public.experiment_arms
         (workspace_id, experiment_id, key, label, is_control, allocation, funnel_version_id, sort_order)
       values ($1, $2, $3, $4, $5, 0.33333, $6, $7)`,
      [
        WORKSPACE_A,
        EXPERIMENT_A,
        key,
        `Funnel ${index + 1}`,
        index === 1,
        funnelVersionId(index),
        index,
      ],
    );
  }

  // Two days of delivery, so the performance tab has something real to fold and
  // the maturity label is derived from the volume rather than asserted.
  for (const [index, day] of ['2026-08-23', '2026-08-24'].entries()) {
    await admin.query(
      `insert into public.performance_rollups
         (workspace_id, day, campaign_id, impressions, link_clicks, spend_minor, currency,
          funnel_sessions, form_starts, submissions, leads, attribution_coverage, data_maturity)
       values ($1, $2, $3, $4, $5, $6, 'EUR', $7, $8, $9, $9, 0.83, 'PARTIAL')`,
      [
        WORKSPACE_A,
        day,
        CAMPAIGN_A,
        4_000 + index * 500,
        80 + index * 10,
        11_000 + index * 400,
        70 + index * 8,
        30 + index * 4,
        9 + index,
      ],
    );
  }
}

/** Repositories bound to one connection, so its RLS context holds throughout. */
export function databaseOn(connection: PgConnectionLike): AmDatabase {
  return createSupabaseDatabase(createPostgrestOverPg(connection) as unknown as DbClient);
}

export interface ScratchClient extends PgConnectionLike {
  end(): Promise<void>;
}

export interface ScratchSession {
  db: AmDatabase;
  transaction: TransactionRunner;
  close(): Promise<void>;
}

/**
 * A session acting as one profile.
 *
 * `set role authenticated` plus the request GUC is what PostgREST does per
 * request, so the repositories run under the same policies they would in
 * production instead of under the owner's blanket access — which would make
 * every RLS assertion vacuous.
 */
export async function actAs(
  open: () => Promise<ScratchClient>,
  profileId: string | null,
  role = 'authenticated',
): Promise<ScratchSession> {
  const reader = await open();
  await reader.query(`set role ${role}`);
  if (profileId) {
    await reader.query(`select set_config('request.jwt.claim.sub', $1, false)`, [profileId]);
    await reader.query(`select set_config('request.jwt.claims', $1, false)`, [
      JSON.stringify({ sub: profileId, role }),
    ]);
  }

  const opened: ScratchClient[] = [reader];
  const transaction: TransactionRunner = async (actor, work) => {
    const writer = await open();
    opened.push(writer);
    try {
      return await withTransaction(
        { query: (text, values) => writer.query(text, values), close: () => writer.end() },
        role,
        actor,
        work,
      );
    } finally {
      await writer.end().catch(() => undefined);
      opened.splice(opened.indexOf(writer), 1);
    }
  };

  return {
    db: databaseOn(reader),
    transaction,
    close: async () => {
      for (const client of opened) await client.end().catch(() => undefined);
    },
  };
}
