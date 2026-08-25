'use server';

import type { MultiStepFormSpec } from '@am/funnel-schema';
import { fixtureBuilderPort } from '@/components/builders/fixture-port';
import type { BuilderPort, PageDocumentSpec, SavedVersion } from '@/components/builders/port';
import { defineAction } from '@/lib/action';
import type { ActionResult } from '@/lib/action-result';

/**
 * Server actions behind the builder routes.
 *
 * Every one of them goes through `defineAction`, so the permission is checked
 * before the handler runs, failures come back as a German `ActionResult` instead
 * of a stack trace, and the change is audited with a redacted payload.
 *
 * The storage behind them is `fixtureBuilderPort` — see the note there. To wire
 * the real repository, replace the single `port` binding below with the
 * repository-backed implementation of `BuilderPort`; nothing else in this file
 * or in the components changes.
 */
const port: BuilderPort = fixtureBuilderPort;

/* -------------------------------------------------------------------------- */
/* Forms                                                                       */
/* -------------------------------------------------------------------------- */

const saveFormDraft = defineAction<
  { versionId: string; spec: MultiStepFormSpec },
  SavedVersion
>({ permission: 'funnel.edit', name: 'builder.form.save_draft' }, async (input, ctx) => {
  const result = await port.saveFormDraft(input.versionId, input.spec);
  if (result.status === 'ok') {
    await ctx.audit({
      action: 'form.version_created',
      entityType: 'form_version',
      entityId: result.data.versionId,
      summaryDe: `Formular-Entwurf ${result.data.version} gespeichert.`,
      after: { title: input.spec.title, steps: input.spec.steps.length },
    });
  }
  return result;
});

const publishFormVersion = defineAction<
  { versionId: string; spec: MultiStepFormSpec },
  { versionId: string }
>({ permission: 'funnel.publish', name: 'builder.form.publish' }, async (input, ctx) => {
  const result = await port.publishFormVersion(input.versionId, input.spec);
  if (result.status === 'ok') {
    await ctx.audit({
      action: 'form.published',
      entityType: 'form_version',
      entityId: result.data.versionId,
      summaryDe: `Formularversion veröffentlicht und eingefroren: ${input.spec.title}.`,
      after: { title: input.spec.title },
    });
  }
  return result;
});

const duplicateFormVersion = defineAction<{ versionId: string }, SavedVersion>(
  { permission: 'funnel.edit', name: 'builder.form.duplicate' },
  async (input, ctx) => {
    const result = await port.duplicateFormVersion(input.versionId);
    if (result.status === 'ok') {
      await ctx.audit({
        action: 'form.version_created',
        entityType: 'form_version',
        entityId: result.data.versionId,
        summaryDe: `Neue Formular-Entwurfsversion ${result.data.version} aus ${input.versionId} erstellt.`,
      });
    }
    return result;
  },
);

const restoreFormVersion = defineAction<
  { versionId: string; sourceVersionId: string },
  SavedVersion
>({ permission: 'funnel.edit', name: 'builder.form.restore' }, async (input, ctx) => {
  const result = await port.restoreFormVersion(input.versionId, input.sourceVersionId);
  if (result.status === 'ok') {
    await ctx.audit({
      action: 'form.version_created',
      entityType: 'form_version',
      entityId: result.data.versionId,
      summaryDe: `Formularversion ${input.sourceVersionId} als neuer Entwurf ${result.data.version} wiederhergestellt.`,
    });
  }
  return result;
});

export async function saveFormDraftAction(
  versionId: string,
  spec: MultiStepFormSpec,
): Promise<ActionResult<SavedVersion>> {
  return saveFormDraft({ versionId, spec });
}

export async function publishFormVersionAction(
  versionId: string,
  spec: MultiStepFormSpec,
): Promise<ActionResult<{ versionId: string }>> {
  return publishFormVersion({ versionId, spec });
}

export async function duplicateFormVersionAction(
  versionId: string,
): Promise<ActionResult<SavedVersion>> {
  return duplicateFormVersion({ versionId });
}

export async function restoreFormVersionAction(
  versionId: string,
  sourceVersionId: string,
): Promise<ActionResult<SavedVersion>> {
  return restoreFormVersion({ versionId, sourceVersionId });
}

/* -------------------------------------------------------------------------- */
/* Pages and hybrid funnels                                                    */
/* -------------------------------------------------------------------------- */

const savePageDraft = defineAction<{ versionId: string; spec: PageDocumentSpec }, SavedVersion>(
  { permission: 'funnel.edit', name: 'builder.page.save_draft' },
  async (input, ctx) => {
    const result = await port.savePageDraft(input.versionId, input.spec);
    if (result.status === 'ok') {
      await ctx.audit({
        action: 'funnel.version_created',
        entityType: 'funnel_version',
        entityId: result.data.versionId,
        summaryDe: `Seiten-Entwurf ${result.data.version} gespeichert.`,
        after: { title: input.spec.title, blocks: input.spec.blocks.length },
      });
    }
    return result;
  },
);

const publishPageVersion = defineAction<
  { versionId: string; spec: PageDocumentSpec },
  { versionId: string }
>({ permission: 'funnel.publish', name: 'builder.page.publish' }, async (input, ctx) => {
  const result = await port.publishPageVersion(input.versionId, input.spec);
  if (result.status === 'ok') {
    await ctx.audit({
      action: 'funnel.published',
      entityType: 'funnel_version',
      entityId: result.data.versionId,
      summaryDe: `Funnel-Version veröffentlicht und eingefroren: ${input.spec.title}.`,
      after: { title: input.spec.title, slug: input.spec.slug },
    });
  }
  return result;
});

const duplicatePageVersion = defineAction<{ versionId: string }, SavedVersion>(
  { permission: 'funnel.edit', name: 'builder.page.duplicate' },
  async (input, ctx) => {
    const result = await port.duplicatePageVersion(input.versionId);
    if (result.status === 'ok') {
      await ctx.audit({
        action: 'funnel.version_created',
        entityType: 'funnel_version',
        entityId: result.data.versionId,
        summaryDe: `Neue Seiten-Entwurfsversion ${result.data.version} aus ${input.versionId} erstellt.`,
      });
    }
    return result;
  },
);

const restorePageVersion = defineAction<
  { versionId: string; sourceVersionId: string },
  SavedVersion
>({ permission: 'funnel.edit', name: 'builder.page.restore' }, async (input, ctx) => {
  const result = await port.restorePageVersion(input.versionId, input.sourceVersionId);
  if (result.status === 'ok') {
    await ctx.audit({
      action: 'funnel.version_created',
      entityType: 'funnel_version',
      entityId: result.data.versionId,
      summaryDe: `Seitenversion ${input.sourceVersionId} als neuer Entwurf ${result.data.version} wiederhergestellt.`,
    });
  }
  return result;
});

export async function savePageDraftAction(
  versionId: string,
  spec: PageDocumentSpec,
): Promise<ActionResult<SavedVersion>> {
  return savePageDraft({ versionId, spec });
}

export async function publishPageVersionAction(
  versionId: string,
  spec: PageDocumentSpec,
): Promise<ActionResult<{ versionId: string }>> {
  return publishPageVersion({ versionId, spec });
}

export async function duplicatePageVersionAction(
  versionId: string,
): Promise<ActionResult<SavedVersion>> {
  return duplicatePageVersion({ versionId });
}

export async function restorePageVersionAction(
  versionId: string,
  sourceVersionId: string,
): Promise<ActionResult<SavedVersion>> {
  return restorePageVersion({ versionId, sourceVersionId });
}
