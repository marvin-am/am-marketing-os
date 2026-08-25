import { RETRY_POLICY, canDispatchCapi, canWriteHubspot, fnv1a32, nextRetryDelayMs, shouldDeadLetter } from '@am/domain';
import { processInBatches } from '../runner';
import type { JobDefinition, JobRunOutcome, OutboxClaim } from '../types';

const BATCH_SIZE = 25;
const CLAIM_LIMIT = 200;

/**
 * The outbox pump.
 *
 * This is the job that makes "a HubSpot outage never loses a lead" true. The
 * lead was already accepted and persisted with its outbox rows in one
 * transaction; this job is the only thing that turns those rows into provider
 * calls, and it is allowed to fail as often as it needs to.
 */
export const outboxDispatchJob: JobDefinition = {
  name: 'outbox-dispatch',
  schedule: '*/5 * * * *',
  descriptionDe:
    'Stellt ausstehende Outbox-Ereignisse an Meta CAPI und HubSpot zu, mit exponentiellem Backoff und Dead-Letter-Queue.',
  requires: ['META', 'HUBSPOT'],

  async run(ctx): Promise<JobRunOutcome> {
    const claims = await ctx.ports.outbox.claimDue(CLAIM_LIMIT, ctx.now, ctx.runId);

    if (claims.length === 0) {
      const counts = await ctx.ports.outbox.countByStatus();
      return {
        ok: true,
        counts: { claimed: 0, ...counts },
        summaryDe: 'Keine fälligen Outbox-Ereignisse.',
        warningsDe: [],
        errorDe: null,
      };
    }

    const capiAllowed = canDispatchCapi(ctx.flags);
    const hubspotAllowed = canWriteHubspot(ctx.flags);
    const warningsDe: string[] = [];

    // A disabled flag is a deliberate state, not an error. The events stay
    // PENDING and deliver once it is switched on, so nothing is lost and
    // nothing is silently dropped.
    if (!capiAllowed) {
      warningsDe.push(
        'Meta-CAPI-Zustellung ist deaktiviert (META_CAPI_ENABLED/EXTERNAL_WRITES_ENABLED). Ereignisse bleiben in der Warteschlange.',
      );
    }
    if (!hubspotAllowed) {
      warningsDe.push(
        'HubSpot-Zustellung ist deaktiviert (HUBSPOT_WRITES_ENABLED/EXTERNAL_WRITES_ENABLED). Ereignisse bleiben in der Warteschlange.',
      );
    }

    let dispatched = 0;
    let failed = 0;
    let deadLettered = 0;
    let held = 0;

    const { aborted, processed } = await processInBatches(
      claims,
      BATCH_SIZE,
      ctx.signal,
      async (batch) => {
        for (const claim of batch) {
          const allowed = isAllowed(claim, capiAllowed, hubspotAllowed);
          if (!allowed) {
            held += 1;
            continue;
          }

          try {
            const response = await dispatch(claim, ctx.providers);
            if (response === 'unavailable') {
              held += 1;
              continue;
            }
            if (response === 'dry_run') {
              held += 1;
              continue;
            }
            await ctx.ports.outbox.markAccepted(claim.eventId, claim.destination, response);
            dispatched += 1;
          } catch (error) {
            const attempt = claim.attemptCount + 1;
            const dead = shouldDeadLetter(attempt, RETRY_POLICY.maxAttempts);
            const delay = nextRetryDelayMs(attempt, fnv1a32(claim.eventId));
            await ctx.ports.outbox.markFailed(
              claim.eventId,
              claim.destination,
              error instanceof Error ? error.message : String(error),
              dead ? null : new Date(ctx.now.getTime() + delay),
              dead,
            );
            if (dead) deadLettered += 1;
            else failed += 1;
          }
        }
        return [];
      },
    );

    if (aborted) {
      warningsDe.push(
        `Lauf wurde nach ${processed} von ${claims.length} Ereignissen beendet (Zeitbudget). Der Rest folgt beim nächsten Durchlauf.`,
      );
    }
    if (deadLettered > 0) {
      warningsDe.push(
        `${deadLettered} Ereignis(se) haben die maximale Anzahl Versuche erreicht und liegen in der Dead-Letter-Queue.`,
      );
    }

    return {
      ok: true,
      counts: { claimed: claims.length, dispatched, failed, deadLettered, held },
      summaryDe:
        held === claims.length
          ? `${claims.length} Ereignis(se) bleiben in der Warteschlange — externe Schreibzugriffe sind deaktiviert.`
          : `${dispatched} zugestellt, ${failed} Wiederholung(en), ${deadLettered} Dead Letter, ${held} zurückgehalten.`,
      warningsDe,
      errorDe: null,
    };
  },
};

function isAllowed(claim: OutboxClaim, capiAllowed: boolean, hubspotAllowed: boolean): boolean {
  if (claim.destination === 'META_CAPI') return capiAllowed;
  if (claim.destination === 'HUBSPOT') return hubspotAllowed;
  if (claim.destination === 'META_MARKETING_API') return capiAllowed;
  return false;
}

type DispatchOutcome = unknown | 'dry_run' | 'unavailable';

async function dispatch(
  claim: OutboxClaim,
  providers: { meta: unknown; hubspot: unknown },
): Promise<DispatchOutcome> {
  if (claim.destination === 'META_CAPI' || claim.destination === 'META_MARKETING_API') {
    const meta = providers.meta as {
      sendCapiEvents(batch: unknown): Promise<{ dryRun: true } | { accepted: number; response: unknown }>;
    } | null;
    if (!meta) return 'unavailable';
    const result = await meta.sendCapiEvents(claim.payload);
    return 'dryRun' in result ? 'dry_run' : result.response;
  }

  const hubspot = providers.hubspot as {
    syncPending(batch: unknown): Promise<{ dryRun: true } | { synced: number; response: unknown }>;
  } | null;
  if (!hubspot) return 'unavailable';
  const result = await hubspot.syncPending(claim.payload);
  return 'dryRun' in result ? 'dry_run' : result.response;
}
