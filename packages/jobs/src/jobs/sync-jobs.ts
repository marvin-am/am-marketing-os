import type { JobDefinition, JobRunOutcome } from '../types';

/** ISO day string, `YYYY-MM-DD`, in UTC. */
function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysAgo(from: Date, days: number): Date {
  return new Date(from.getTime() - days * 24 * 60 * 60 * 1000);
}

/* -------------------------------------------------------------------------- */
/* Meta insights                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Hourly insights for live campaigns.
 *
 * Re-reads a small trailing window rather than only "since the cursor": Meta
 * revises the current and previous day as attribution settles, so a strict
 * high-watermark would permanently freeze whatever the first read happened to
 * see.
 */
export const metaInsightsJob: JobDefinition = {
  name: 'meta-insights',
  schedule: '7 * * * *',
  descriptionDe: 'Liest stündlich die Meta-Insights laufender Kampagnen und spiegelt sie nach Supabase.',
  requires: ['META'],

  async run(ctx): Promise<JobRunOutcome> {
    if (!ctx.providers.meta) {
      return skipped('Meta ist nicht verbunden. Insights werden nicht abgerufen.');
    }

    const since = isoDay(daysAgo(ctx.now, 3));
    const until = isoDay(ctx.now);
    const { rows } = await ctx.providers.meta.fetchInsightsDaily({ since, until });

    await ctx.ports.sync.set('META', 'insights_daily', { watermark: until });

    return {
      ok: true,
      counts: { rows: rows.length, days: 4 },
      summaryDe: `${rows.length} Insights-Zeile(n) für ${since} bis ${until} gespiegelt.`,
      warningsDe: [],
      errorDe: null,
    };
  },
};

/* -------------------------------------------------------------------------- */
/* Meta backfill                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Daily backfill over a wider window, for conversions Meta attributes late.
 * Without it, the last week of every campaign permanently under-reports.
 */
export const metaBackfillJob: JobDefinition = {
  name: 'meta-backfill',
  schedule: '20 3 * * *',
  descriptionDe:
    'Liest täglich ein breiteres Zeitfenster erneut, um verspätet attribuierte Conversions nachzuziehen.',
  requires: ['META'],

  async run(ctx): Promise<JobRunOutcome> {
    if (!ctx.providers.meta) {
      return skipped('Meta ist nicht verbunden. Backfill übersprungen.');
    }

    const since = isoDay(daysAgo(ctx.now, 28));
    const until = isoDay(ctx.now);
    const { rows } = await ctx.providers.meta.fetchInsightsDaily({ since, until });

    await ctx.ports.sync.set('META', 'insights_backfill', { watermark: until });

    return {
      ok: true,
      counts: { rows: rows.length, windowDays: 28 },
      summaryDe: `Backfill über 28 Tage: ${rows.length} Zeile(n) aktualisiert.`,
      warningsDe: [],
      errorDe: null,
    };
  },
};

/* -------------------------------------------------------------------------- */
/* HubSpot reconciliation                                                      */
/* -------------------------------------------------------------------------- */

function hubspotReconcileJob(deep: boolean): JobDefinition {
  return {
    name: deep ? 'hubspot-reconcile-deep' : 'hubspot-reconcile',
    schedule: deep ? '50 4 * * *' : '35 * * * *',
    descriptionDe: deep
      ? 'Täglicher, vollständiger Abgleich der gespiegelten HubSpot-Objekte inklusive Wert- und Stufenabweichungen.'
      : 'Stündlicher Abgleich der zuletzt geänderten HubSpot-Objekte. Fängt auf, was ein verpasster Webhook verloren hätte.',
    requires: ['HUBSPOT'],

    async run(ctx): Promise<JobRunOutcome> {
      if (!ctx.providers.hubspot) {
        return skipped('HubSpot ist nicht verbunden. Abgleich übersprungen.');
      }

      const cursor = await ctx.ports.sync.get('HUBSPOT', deep ? 'reconcile_deep' : 'reconcile');
      const since = deep ? null : cursor.watermark;

      const outcome = await ctx.providers.hubspot.reconcile({ deep, since });

      await ctx.ports.sync.set('HUBSPOT', deep ? 'reconcile_deep' : 'reconcile', {
        watermark: ctx.now.toISOString(),
      });

      const warningsDe: string[] = [];
      if (outcome.discrepancies > 0) {
        warningsDe.push(
          `${outcome.discrepancies} Abweichung(en) gefunden — z. B. ein Dealwert, der sich nach CLOSED_WON geändert hat. Diese erzeugen bewusst kein zweites Conversion-Ereignis.`,
        );
      }

      return {
        ok: true,
        counts: {
          checked: outcome.checked,
          transitions: outcome.transitions,
          discrepancies: outcome.discrepancies,
        },
        summaryDe: `${outcome.checked} Objekt(e) geprüft, ${outcome.transitions} echte Zustandsübergänge, ${outcome.discrepancies} Abweichung(en).`,
        warningsDe,
        errorDe: null,
      };
    },
  };
}

export const hubspotReconcileHourlyJob = hubspotReconcileJob(false);
export const hubspotReconcileDeepJob = hubspotReconcileJob(true);

/* -------------------------------------------------------------------------- */
/* Integration health                                                          */
/* -------------------------------------------------------------------------- */

export const integrationHealthJob: JobDefinition = {
  name: 'integration-health',
  schedule: '0 */6 * * *',
  descriptionDe: 'Aktualisiert den Health-Status aller Provider für die Integrationsübersicht.',
  requires: [],

  async run(ctx): Promise<JobRunOutcome> {
    const warningsDe: string[] = [];
    let checked = 0;

    if (ctx.providers.meta) {
      await ctx.ports.health.record('META', await ctx.providers.meta.health());
      checked += 1;
    } else {
      warningsDe.push('Meta ist nicht verbunden — Status bleibt "wartet auf externen Input".');
    }

    if (ctx.providers.hubspot) {
      await ctx.ports.health.record('HUBSPOT', await ctx.providers.hubspot.health());
      checked += 1;
    } else {
      warningsDe.push('HubSpot ist nicht verbunden — Status bleibt "wartet auf externen Input".');
    }

    return {
      ok: true,
      counts: { checked },
      summaryDe: `${checked} Provider geprüft.`,
      warningsDe,
      errorDe: null,
    };
  },
};

function skipped(summaryDe: string): JobRunOutcome {
  return {
    ok: true,
    counts: { skipped: 1 },
    summaryDe,
    warningsDe: [summaryDe],
    errorDe: null,
  };
}
