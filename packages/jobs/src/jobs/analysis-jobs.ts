import type { JobDefinition, JobRunOutcome } from '../types';

/* -------------------------------------------------------------------------- */
/* Abandoned forms                                                             */
/* -------------------------------------------------------------------------- */

const ABANDON_BATCH = 500;

/**
 * Derives `form_abandoned` server-side after an inactivity window.
 *
 * Deliberately not driven by `beforeunload`: that event does not fire reliably
 * on mobile Safari, which is most of the traffic, and an abandonment rate built
 * on it is wrong in the direction that flatters the funnel.
 */
export const deriveAbandonedFormsJob: JobDefinition = {
  name: 'derive-abandoned-forms',
  schedule: '*/15 * * * *',
  descriptionDe:
    'Leitet abgebrochene Formulare nach einem Inaktivitätsfenster serverseitig ab, statt sich auf beforeunload zu verlassen.',
  requires: [],

  async run(ctx): Promise<JobRunOutcome> {
    const minutes = abandonMinutes();
    const cutoff = new Date(ctx.now.getTime() - minutes * 60 * 1000);
    const stale = await ctx.ports.forms.listStaleOpen(cutoff, ABANDON_BATCH);

    let derived = 0;
    for (const instance of stale) {
      if (ctx.signal.aborted) break;
      if (instance.submitted || instance.abandonedRecorded) continue;
      // The business time is when activity stopped, not when this job noticed.
      await ctx.ports.forms.markAbandoned(instance.formInstanceId, instance.lastActivityAt);
      derived += 1;
    }

    return {
      ok: true,
      counts: { candidates: stale.length, derived, inactivityMinutes: minutes },
      summaryDe:
        derived === 0
          ? 'Keine neuen Formularabbrüche.'
          : `${derived} Formularabbruch/-abbrüche nach ${minutes} Minuten Inaktivität abgeleitet.`,
      warningsDe:
        stale.length === ABANDON_BATCH
          ? ['Batch-Limit erreicht — der Rest folgt beim nächsten Durchlauf.']
          : [],
      errorDe: null,
    };
  },
};

function abandonMinutes(): number {
  const raw = typeof process !== 'undefined' ? process.env.FORM_ABANDON_MINUTES : undefined;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
}

/* -------------------------------------------------------------------------- */
/* Performance rollups                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Daily rollups. Dashboards read these, never the raw event stream and never a
 * provider API — a dashboard that fans out to the Graph API is both slow and
 * rate-limit fragile.
 */
export const performanceRollupsJob: JobDefinition = {
  name: 'performance-rollups',
  schedule: '10 2 * * *',
  descriptionDe:
    'Berechnet die täglichen Performance-Rollups je Kampagne, Creative, Funnel und Experimentarm.',
  requires: [],

  async run(ctx): Promise<JobRunOutcome> {
    // Recompute a trailing window rather than only yesterday: late CRM outcomes
    // and Meta's own revisions change days that are already "done".
    const until = ctx.now;
    const since = new Date(ctx.now.getTime() - 35 * 24 * 60 * 60 * 1000);
    const days = await ctx.ports.rollups.listDaysNeedingRollup(since, until);

    let written = 0;
    let processedDays = 0;

    for (const day of days) {
      if (ctx.signal.aborted) break;
      const counters = await ctx.ports.rollups.loadDailyCounters(day);
      written += await ctx.ports.rollups.writeRollups(day, counters);
      processedDays += 1;
    }

    return {
      ok: true,
      counts: { days: processedDays, rows: written },
      summaryDe: `${written} Rollup-Zeile(n) für ${processedDays} Tag(e) berechnet.`,
      warningsDe:
        processedDays < days.length
          ? [`${days.length - processedDays} Tag(e) offen — Zeitbudget erreicht.`]
          : [],
      errorDe: null,
    };
  },
};

/* -------------------------------------------------------------------------- */
/* Learning cards                                                              */
/* -------------------------------------------------------------------------- */

export const learningCardsJob: JobDefinition = {
  name: 'learning-cards',
  schedule: '40 5 * * *',
  descriptionDe:
    'Erzeugt Learning Cards für abgeschlossene Experimente, sobald deren CRM-Ergebnisse reif sind.',
  requires: [],

  async run(ctx): Promise<JobRunOutcome> {
    const pending = await ctx.ports.learnings.listExperimentsNeedingCards(ctx.now);

    let created = 0;
    for (const item of pending) {
      if (ctx.signal.aborted) break;
      await ctx.ports.learnings.writeLearningCard(item);
      created += 1;
    }

    return {
      ok: true,
      counts: { candidates: pending.length, created },
      summaryDe:
        created === 0
          ? 'Keine neuen Learning Cards — es sind keine Experimente reif.'
          : `${created} Learning Card(s) erzeugt.`,
      warningsDe: [],
      errorDe: null,
    };
  },
};

/* -------------------------------------------------------------------------- */
/* Recommendations                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Regenerates recommendations for active campaigns.
 *
 * Nothing here executes anything. The engine produces proposals; a human
 * confirms, and only then does a command reach a provider.
 */
export const recommendationsJob: JobDefinition = {
  name: 'recommendations',
  schedule: '25 6 * * *',
  descriptionDe:
    'Berechnet die Empfehlungen aktiver Kampagnen neu. Es wird nichts automatisch ausgeführt.',
  requires: [],

  async run(ctx): Promise<JobRunOutcome> {
    const campaigns = await ctx.ports.recommendations.listActiveCampaigns();

    let generated = 0;
    let skipped = 0;

    for (const campaign of campaigns) {
      if (ctx.signal.aborted) break;
      const context = await ctx.ports.recommendations.loadContext(campaign.campaignId);
      if (!context) {
        skipped += 1;
        continue;
      }
      generated += await ctx.ports.recommendations.replaceOpenRecommendations(
        campaign.campaignId,
        [context],
      );
    }

    return {
      ok: true,
      counts: { campaigns: campaigns.length, generated, skipped },
      summaryDe: `${generated} Empfehlung(en) für ${campaigns.length} aktive Kampagne(n) aktualisiert.`,
      warningsDe: skipped > 0 ? [`${skipped} Kampagne(n) ohne auswertbaren Kontext übersprungen.`] : [],
      errorDe: null,
    };
  },
};
