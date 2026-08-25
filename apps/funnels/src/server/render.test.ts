import { beforeEach, describe, expect, it } from 'vitest';

process.env.LOG_LEVEL = 'error';

import { MINTED_VISITOR_HEADER } from '@am/tracking';
import { FIXTURE_FUNNEL_IDS, FIXTURE_SLUGS } from './fixture-store';
import { assignFunnelArm } from './assignment';
import { getPublishedFunnelBySlug, resetPublishedCache, resolveServedFunnel } from './published';
import { prepareFunnel } from './render';
import { runtimeContextFrom } from './request';
import { resolveRuntimeContext } from './runtime-context';
import { getFixtureStore, resetFunnelStore } from './store';

/**
 * Render preparation: what a page writes, what it refuses to write, and which
 * version a given visitor is served.
 */

const HUMAN_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const CRAWLER_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

function contextFor(visitorId: string, userAgent: string) {
  return resolveRuntimeContext({
    cookieHeader: `am_vid=${visitorId}; am_sid=${visitorId}.1756000000000.1756000000000`,
    userAgent,
    host: 'funnel.example.com',
    url: 'https://funnel.example.com/f/potenzialanalyse',
    referer: null,
    acceptLanguage: 'de-DE,de;q=0.9',
    secFetchSite: 'none',
    now: new Date('2026-08-25T10:00:00.000Z'),
  });
}

const VISITOR_A = 'c1c2c3c4-0000-4000-8000-00000000000a';
const VISITOR_B = 'c1c2c3c4-0000-4000-8000-00000000000b';

beforeEach(() => {
  resetFunnelStore();
  resetPublishedCache();
});

describe('published versions only', () => {
  it('serves the published version behind a slug', async () => {
    const version = await getPublishedFunnelBySlug(FIXTURE_SLUGS.landing);
    expect(version?.state).toBe('PUBLISHED');
    expect(version?.funnelVersionId).toBe(FIXTURE_FUNNEL_IDS.landingFunnelVersionId);
  });

  it('never resolves a slug to a draft, even when one exists for it', async () => {
    /* The fixture store deliberately carries an unpublished draft on the same
       slug. A rule nothing ever tries to break is not a tested rule. */
    const served = await resolveServedFunnel(FIXTURE_SLUGS.landing, VISITOR_A);
    expect(served?.version.funnelVersionId).not.toBe(FIXTURE_FUNNEL_IDS.draftFunnelVersionId);
    expect(served?.version.state).toBe('PUBLISHED');
  });

  it('returns nothing for an unknown slug', async () => {
    expect(await resolveServedFunnel('gibt-es-nicht', VISITOR_A)).toBeNull();
  });
});

describe('arm assignment', () => {
  it('is stable for a visitor across repeated resolutions', async () => {
    const first = await resolveServedFunnel(FIXTURE_SLUGS.form, VISITOR_A);
    const second = await resolveServedFunnel(FIXTURE_SLUGS.form, VISITOR_A);

    expect(first?.assignment?.armId).toBeDefined();
    expect(second?.assignment?.armId).toBe(first?.assignment?.armId);
    expect(second?.version.funnelVersionId).toBe(first?.version.funnelVersionId);
  });

  it('serves the version the assigned arm points at', async () => {
    const served = await resolveServedFunnel(FIXTURE_SLUGS.form, VISITOR_B);
    expect(served?.version.funnelVersionId).toBe(served?.assignment?.funnelVersionId);
  });

  it('does not assign for an experiment that is not running', () => {
    const base = {
      experimentId: FIXTURE_FUNNEL_IDS.experimentId,
      assignmentSalt: 'potenzialanalyse-intro-2026-01',
      arms: [
        { armId: 'a', allocation: 1, funnelVersionId: FIXTURE_FUNNEL_IDS.formFunnelVersionA },
      ],
    };

    expect(assignFunnelArm({ ...base, state: 'RUNNING' }, VISITOR_A)).not.toBeNull();
    expect(assignFunnelArm({ ...base, state: 'PAUSED' }, VISITOR_A)).toBeNull();
    expect(assignFunnelArm({ ...base, state: 'CONCLUDED' }, VISITOR_A)).toBeNull();
    expect(assignFunnelArm(null, VISITOR_A)).toBeNull();
  });

  it('spreads visitors across both arms', () => {
    const experiment = {
      experimentId: FIXTURE_FUNNEL_IDS.experimentId,
      state: 'RUNNING' as const,
      assignmentSalt: 'potenzialanalyse-intro-2026-01',
      arms: [
        { armId: 'a', allocation: 0.5, funnelVersionId: FIXTURE_FUNNEL_IDS.formFunnelVersionA },
        { armId: 'b', allocation: 0.5, funnelVersionId: FIXTURE_FUNNEL_IDS.formFunnelVersionB },
      ],
    };

    const arms = new Set(
      Array.from({ length: 40 }, (_, index) =>
        assignFunnelArm(experiment, `c1c2c3c4-0000-4000-8000-0000000000${index.toString(16).padStart(2, '0')}`)?.armId,
      ),
    );
    expect(arms).toEqual(new Set(['a', 'b']));
  });
});

describe('what a render writes', () => {
  it('opens exactly one form instance per visitor, session and form version', async () => {
    const served = await resolveServedFunnel(FIXTURE_SLUGS.form, VISITOR_A);
    const context = contextFor(VISITOR_A, HUMAN_UA);

    const first = await prepareFunnel(served!.version, context, served!.assignment);
    const second = await prepareFunnel(served!.version, context, served!.assignment);

    expect(second.formInstanceId).toBe(first.formInstanceId);
    expect(getFixtureStore().snapshot().formInstances).toHaveLength(1);
  });

  it('records the visit as exactly one touch, however often the tree renders', async () => {
    const served = await resolveServedFunnel(FIXTURE_SLUGS.landing, VISITOR_A);
    const context = contextFor(VISITOR_A, HUMAN_UA);

    await prepareFunnel(served!.version, context, null);
    await prepareFunnel(served!.version, context, null);

    expect(await getFixtureStore().listTouches(VISITOR_A)).toHaveLength(1);
  });

  it('renders the full page for a crawler but writes nothing for it', async () => {
    const served = await resolveServedFunnel(FIXTURE_SLUGS.form, VISITOR_A);
    const context = contextFor(VISITOR_A, CRAWLER_UA);
    expect(context.trafficKind).toBe('BOT');

    const prepared = await prepareFunnel(served!.version, context, served!.assignment);

    /* A blank Meta share card is a real cost, so the form still renders … */
    expect(prepared.formSpec).not.toBeNull();
    expect(prepared.formInstanceId).not.toBeNull();
    /* … but the crawl leaves no instance and no touch behind to dilute metrics. */
    expect(getFixtureStore().snapshot().formInstances).toHaveLength(0);
    expect(await getFixtureStore().listTouches(VISITOR_A)).toHaveLength(0);
  });

  it('classifies a preview render out of production traffic', () => {
    const context = resolveRuntimeContext({
      cookieHeader: `am_vid=${VISITOR_A}; am_preview=1`,
      userAgent: HUMAN_UA,
      host: 'funnel.example.com',
      url: 'https://funnel.example.com/preview/abc',
      referer: null,
      acceptLanguage: 'de-DE',
      secFetchSite: 'none',
      isPreviewRoute: true,
      now: new Date('2026-08-25T10:00:00.000Z'),
    });

    expect(context.trafficKind).toBe('PREVIEW');
  });

  it('reports whether the visitor id was presented or minted', () => {
    /* A minted id is indistinguishable from a returning one downstream unless
       the resolver says so, and the rate limiter has to know: a caller that
       sends no cookie gets a fresh id on every request, so treating that id as
       an identity would give it a fresh budget on every request too. */
    const resolve = (overrides: Record<string, unknown>) =>
      resolveRuntimeContext({
        cookieHeader: null,
        userAgent: HUMAN_UA,
        host: 'funnel.example.com',
        url: 'https://funnel.example.com/f/potenzialanalyse',
        referer: null,
        acceptLanguage: 'de-DE',
        secFetchSite: 'none',
        now: new Date('2026-08-25T10:00:00.000Z'),
        ...overrides,
      });

    expect(resolve({}).visitorPresented).toBe(false);
    expect(contextFor(VISITOR_A, HUMAN_UA).visitorPresented).toBe(true);

    /* The edge issues identity and forwards it in the cookie header, so a cookie
       alone proves nothing about who sent it — a caller that omits `am_vid`
       arrives here carrying one the edge minted a moment earlier. */
    expect(
      resolve({
        cookieHeader: `am_vid=${VISITOR_A}`,
        visitorMintedAtEdge: true,
      }).visitorPresented,
    ).toBe(false);
  });

  it('takes the edge at its word about a minted visitor id', () => {
    const headerList = new Headers({
      cookie: `am_vid=${VISITOR_A}`,
      'user-agent': HUMAN_UA,
      host: 'funnel.example.com',
      'accept-language': 'de-DE',
      [MINTED_VISITOR_HEADER]: '1',
    });
    const resolve = () =>
      runtimeContextFrom(headerList, 'https://funnel.example.com/api/collect').visitorPresented;

    expect(resolve()).toBe(false);
    headerList.set(MINTED_VISITOR_HEADER, '0');
    expect(resolve()).toBe(true);
  });

  it('hands the client the ids of the version it actually served', async () => {
    const served = await resolveServedFunnel(FIXTURE_SLUGS.form, VISITOR_A);
    const prepared = await prepareFunnel(
      served!.version,
      contextFor(VISITOR_A, HUMAN_UA),
      served!.assignment,
    );

    expect(prepared.trackerContext.funnel_version_id).toBe(served!.version.funnelVersionId);
    expect(prepared.trackerContext.experiment_arm_id).toBe(served!.assignment?.armId);
    expect(prepared.trackerContext.visitor_id).toBe(VISITOR_A);
  });
});
