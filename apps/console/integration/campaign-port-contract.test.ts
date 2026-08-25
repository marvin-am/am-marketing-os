import { afterAll, beforeAll, describe } from 'vitest';
import { announceSkip, HAS_DATABASE, setupDatabase, type Harness } from '../../../supabase/tests/harness';
import { createDatabaseCampaignPort } from '@/server/campaign-db-port';
import { FIXTURE_CAMPAIGN_IDS, getCampaignPort, setCampaignPort } from '@/server/campaign-fixtures';
import type { CampaignPort } from '@/server/campaign-port';
import {
  actAs,
  CAMPAIGN_A,
  PROFILE_LEAD,
  seedCampaignScratch,
  WORKSPACE_A,
  type ScratchClient,
  type ScratchSession,
} from './fixtures/campaign-scratch';
import { describeCampaignPortContract } from './fixtures/campaign-port-contract';

/**
 * One contract, both implementations.
 *
 * The fixture half runs everywhere. The Postgres half runs against a scratch
 * database of its own — created, migrated and dropped by the harness — and skips
 * cleanly when `DATABASE_URL` is unset, so a green run on a machine without a
 * database is not mistaken for coverage.
 *
 * Running the same assertions twice is the only way the claim "swapping the port
 * changes no screen" is checked rather than asserted. Where the two datasets
 * differ, the assertions are about the rule, not about the row.
 */

describe('CampaignPort contract — fixture', () => {
  beforeAll(() => {
    // The factory is a process-wide singleton; reset it so a previous file's
    // substitution cannot decide what this one is testing.
    setCampaignPort(null);
  });

  describeCampaignPortContract(() => ({
    name: 'fixture',
    port: getCampaignPort(),
    campaignId: FIXTURE_CAMPAIGN_IDS.live,
    mutableCampaignId: FIXTURE_CAMPAIGN_IDS.assetReview,
    actor: { id: '0aaa0001-0000-4000-8000-0000000000a2', displayName: 'Marketing Lead' },
    actorRoles: ['MARKETING_LEAD'],
  }));
});

if (!HAS_DATABASE) announceSkip('apps/console/integration/campaign-port-contract.test.ts');

describe.skipIf(!HAS_DATABASE)('CampaignPort contract — Postgres', () => {
  let harness: Harness;
  let session: ScratchSession;
  let port: CampaignPort;

  beforeAll(async () => {
    harness = await setupDatabase('campaign_contract');
    await seedCampaignScratch(harness.admin);
    session = await actAs(harness.open as () => Promise<ScratchClient>, PROFILE_LEAD);
    port = createDatabaseCampaignPort({
      database: async () => session.db,
      workspaceId: WORKSPACE_A,
      transaction: session.transaction,
      now: () => new Date('2026-08-25T09:00:00.000Z'),
    });
  });

  afterAll(async () => {
    await session?.close();
    await harness?.teardown();
  });

  describeCampaignPortContract(() => ({
    name: 'postgres',
    port,
    campaignId: CAMPAIGN_A,
    mutableCampaignId: CAMPAIGN_A,
    actor: { id: PROFILE_LEAD, displayName: 'Marketing Lead' },
    actorRoles: ['MARKETING_LEAD'],
  }));
});
