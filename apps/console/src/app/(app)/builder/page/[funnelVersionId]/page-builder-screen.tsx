'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { PageBuilder } from '@/components/builders/page/page-builder';
import type {
  FormChoice,
  PageBuilderCommands,
  PageDocumentSpec,
  VersionSummary,
} from '@/components/builders/port';
import {
  duplicatePageVersionAction,
  publishPageVersionAction,
  restorePageVersionAction,
  savePageDraftAction,
} from '../../actions';

/** Binds the page builder to the server actions and to the router. */

export interface PageBuilderScreenProps {
  versionId: string;
  spec: PageDocumentSpec;
  version: number;
  published: boolean;
  versions: VersionSummary[];
  availableForms: FormChoice[];
}

export function PageBuilderScreen({
  versionId,
  spec,
  version,
  published,
  versions,
  availableForms,
}: PageBuilderScreenProps) {
  const router = useRouter();

  const commands: PageBuilderCommands = React.useMemo(
    () => ({
      save: (next) => savePageDraftAction(versionId, next),
      publish: (next) => publishPageVersionAction(versionId, next),
      duplicate: () => duplicatePageVersionAction(versionId),
      restore: (sourceVersionId) => restorePageVersionAction(versionId, sourceVersionId),
    }),
    [versionId],
  );

  return (
    <PageBuilder
      key={versionId}
      initialSpec={spec}
      version={version}
      published={published}
      versions={versions}
      availableForms={availableForms}
      commands={commands}
      onOpenVersion={(nextVersionId) => {
        router.push(`/builder/page/${nextVersionId}`);
        router.refresh();
      }}
    />
  );
}
