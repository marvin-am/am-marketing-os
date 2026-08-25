'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import type { MultiStepFormSpec } from '@am/funnel-schema';
import { FormBuilder } from '@/components/builders/form/form-builder';
import type { ConsentTextOption, FormBuilderCommands, VersionSummary } from '@/components/builders/port';
import {
  duplicateFormVersionAction,
  publishFormVersionAction,
  restoreFormVersionAction,
  saveFormDraftAction,
} from '../../actions';

/**
 * Binds the form builder to the server actions and to the router.
 *
 * The builder itself knows nothing about Next.js: it receives four promises and
 * a navigation callback. That is what lets the component tests drive it with
 * plain spies and what will let the lead swap the fixture port for the real
 * repository without touching a single component.
 */

export interface FormBuilderScreenProps {
  versionId: string;
  spec: MultiStepFormSpec;
  version: number;
  published: boolean;
  versions: VersionSummary[];
  consentTexts: ConsentTextOption[];
}

export function FormBuilderScreen({
  versionId,
  spec,
  version,
  published,
  versions,
  consentTexts,
}: FormBuilderScreenProps) {
  const router = useRouter();

  const commands: FormBuilderCommands = React.useMemo(
    () => ({
      save: (next) => saveFormDraftAction(versionId, next),
      publish: (next) => publishFormVersionAction(versionId, next),
      duplicate: () => duplicateFormVersionAction(versionId),
      restore: (sourceVersionId) => restoreFormVersionAction(versionId, sourceVersionId),
    }),
    [versionId],
  );

  return (
    <FormBuilder
      key={versionId}
      initialSpec={spec}
      version={version}
      published={published}
      versions={versions}
      consentTexts={consentTexts}
      commands={commands}
      onOpenVersion={(nextVersionId) => {
        router.push(`/builder/form/${nextVersionId}`);
        router.refresh();
      }}
    />
  );
}
