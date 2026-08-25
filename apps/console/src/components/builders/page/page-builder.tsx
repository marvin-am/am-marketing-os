'use client';

import * as React from 'react';
import { Copy, Plus, Trash2 } from 'lucide-react';
import {
  hasBlockingIssues,
  validateHybridSpec,
  validatePageSpec,
  PAGE_BLOCK_LABELS_DE,
  type PageBlockType,
} from '@am/funnel-schema';
import { cn, Badge, Button, ConfirmDialog, Label, Section } from '@am/ui';
import { NativeSelect, SelectControl, TextControl } from '../controls';
import { blockTokens, issueSummaryTextDe, issuesFor } from '../issues';
import { IssueMarker, IssueSummaryPanel } from '../issue-views';
import { OrderableList } from '../orderable';
import type { PageBuilderCommands, PageDocumentSpec, VersionSummary } from '../port';
import { PagePreview } from '../preview/page-preview';
import { VersionBar } from '../version-bar';
import { BlockEditor, FormRefEditor, type FormChoice } from './block-editor';
import {
  addBlock,
  blockLimitsFor,
  defaultFormRef,
  deleteBlock,
  duplicateBlock,
  isHybrid,
  moveBlock,
  updateEmbeddedForm,
} from './page-ops';

/**
 * The landing page and hybrid funnel builder.
 *
 * Same three-pane shape as the form builder — block list, typed block editor,
 * live preview — because they are the same job on a different document, and an
 * operator should not have to learn two interfaces.
 *
 * A hybrid funnel gets one extra section: the reference to the form that does
 * the actual converting, including whether it sits inline or behind a button and
 * after which block it appears.
 */

const BLOCK_TYPES = Object.keys(PAGE_BLOCK_LABELS_DE) as PageBlockType[];

type Pane = 'structure' | 'editor' | 'preview';

export interface PageBuilderProps {
  initialSpec: PageDocumentSpec;
  version: number;
  published: boolean;
  versions: readonly VersionSummary[];
  availableForms: readonly FormChoice[];
  commands: PageBuilderCommands;
  onOpenVersion: (versionId: string) => void;
}

export function PageBuilder({
  initialSpec,
  version,
  published,
  versions,
  availableForms,
  commands,
  onOpenVersion,
}: PageBuilderProps) {
  const [spec, setSpec] = React.useState(initialSpec);
  const [dirty, setDirty] = React.useState(false);
  const [selectedBlockId, setSelectedBlockId] = React.useState<string | null>(
    initialSpec.blocks[0]?.blockId ?? null,
  );
  const [newBlockType, setNewBlockType] = React.useState<PageBlockType>('BENEFIT');
  const [pane, setPane] = React.useState<Pane>('editor');
  const [pendingDelete, setPendingDelete] = React.useState<string | null>(null);
  const [showSettings, setShowSettings] = React.useState(false);
  const newBlockTypeId = React.useId();

  const issues = React.useMemo(
    () => (isHybrid(spec) ? validateHybridSpec(spec) : validatePageSpec(spec)),
    [spec],
  );
  const blocking = hasBlockingIssues(issues);
  const disabled = published;
  const limits = blockLimitsFor(spec);

  const update = (next: PageDocumentSpec) => {
    setSpec(next);
    setDirty(true);
  };

  const selectedBlock = spec.blocks.find((block) => block.blockId === selectedBlockId) ?? null;
  const formRef = defaultFormRef(spec);
  const canAddEmbeddedForm = formRef !== null || availableForms.length > 0;

  return (
    <div className="flex flex-col gap-6">
      <VersionBar
        titleDe={spec.title}
        descriptionDe={
          isHybrid(spec)
            ? 'Hybride Strecke: kurze Seite plus eingebundenes Formular.'
            : 'Landingpage: Blöcke, Reihenfolge und Inhalte.'
        }
        spec={spec}
        version={version}
        published={published}
        dirty={dirty}
        blocking={blocking}
        issueSummaryDe={issueSummaryTextDe(issues)}
        versions={versions}
        commands={commands}
        onOpenVersion={onOpenVersion}
        onSaved={() => setDirty(false)}
      />

      <IssueSummaryPanel issues={issues} titleDe="Offene Hinweise zur Seite" />

      <div className="flex gap-2 md:hidden" role="group" aria-label="Bereich wählen">
        {(
          [
            ['structure', 'Blöcke'],
            ['editor', 'Bearbeiten'],
            ['preview', 'Vorschau'],
          ] as const
        ).map(([id, labelDe]) => (
          <Button
            key={id}
            type="button"
            size="sm"
            variant={pane === id ? 'secondary' : 'ghost'}
            aria-pressed={pane === id}
            onClick={() => setPane(id)}
          >
            {labelDe}
          </Button>
        ))}
      </div>

      <div className="grid min-w-0 gap-6 lg:grid-cols-[18rem_minmax(0,1fr)] xl:grid-cols-[18rem_minmax(0,1fr)_26rem]">
        <nav
          aria-label="Struktur der Seite"
          className={cn('flex min-w-0 flex-col gap-4', pane !== 'structure' && 'max-md:hidden')}
        >
          <Button
            type="button"
            variant={showSettings ? 'secondary' : 'ghost'}
            block
            className="justify-start"
            aria-pressed={showSettings}
            onClick={() => {
              setShowSettings(true);
              setPane('editor');
            }}
          >
            Seiteneinstellungen
          </Button>

          <div className="flex flex-col gap-2">
            <Label htmlFor={newBlockTypeId} className="text-xs font-normal text-muted-foreground">
              Blocktyp
            </Label>
            <div className="flex gap-2">
              <NativeSelect
                id={newBlockTypeId}
                selectSize="sm"
                value={newBlockType}
                disabled={disabled}
                onChange={(event) => setNewBlockType(event.target.value as PageBlockType)}
              >
                {BLOCK_TYPES.map((type) => (
                  <option
                    key={type}
                    value={type}
                    disabled={type === 'EMBEDDED_CONTACT' && !canAddEmbeddedForm}
                  >
                    {PAGE_BLOCK_LABELS_DE[type]}
                  </option>
                ))}
              </NativeSelect>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={disabled || spec.blocks.length >= limits.max}
                title={
                  spec.blocks.length >= limits.max
                    ? `Diese Seite fasst höchstens ${limits.max} Blöcke.`
                    : undefined
                }
                onClick={() => {
                  const result = addBlock(
                    spec,
                    newBlockType,
                    selectedBlockId,
                    formRef ??
                      (availableForms[0]
                        ? {
                            mode: 'INLINE' as const,
                            formId: availableForms[0].formId,
                            formVersionId: availableForms[0].formVersionId,
                            triggerLabel: 'Formular öffnen',
                            anchorBlockId: null,
                          }
                        : null),
                  );
                  if (!result.blockId) return;
                  update(result.spec);
                  setSelectedBlockId(result.blockId);
                  setShowSettings(false);
                  setPane('editor');
                }}
              >
                <Plus aria-hidden="true" />
                Block
              </Button>
            </div>
            {newBlockType === 'EMBEDDED_CONTACT' && !canAddEmbeddedForm ? (
              <p className="text-xs text-warning">
                Es ist noch keine Formularversion verfügbar, auf die dieser Block verweisen könnte.
              </p>
            ) : null}
          </div>

          <OrderableList
            itemNounDe="Block"
            disabled={disabled}
            emptyDe="Diese Seite hat noch keinen Block."
            onReorder={(from, to) => update(moveBlock(spec, from, to))}
            entries={spec.blocks.map((block, index) => {
              const blockIssues = issuesFor(issues, ...blockTokens(block.blockId, index));
              const active = block.blockId === selectedBlockId && !showSettings;
              return {
                id: block.blockId,
                labelDe: PAGE_BLOCK_LABELS_DE[block.type],
                content: (
                  <div className="flex flex-col gap-1 px-1">
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant={active ? 'secondary' : 'ghost'}
                        size="sm"
                        className="min-w-0 flex-1 justify-start"
                        aria-current={active ? 'true' : undefined}
                        onClick={() => {
                          setSelectedBlockId(block.blockId);
                          setShowSettings(false);
                          setPane('editor');
                        }}
                      >
                        <span className="truncate">
                          {`${index + 1}. ${PAGE_BLOCK_LABELS_DE[block.type]}`}
                        </span>
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        disabled={disabled || spec.blocks.length >= limits.max}
                        aria-label={`Block „${PAGE_BLOCK_LABELS_DE[block.type]}“ duplizieren`}
                        onClick={() => {
                          const result = duplicateBlock(spec, block.blockId);
                          update(result.spec);
                          setSelectedBlockId(result.blockId);
                        }}
                      >
                        <Copy aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        disabled={disabled || spec.blocks.length <= limits.min}
                        aria-label={`Block „${PAGE_BLOCK_LABELS_DE[block.type]}“ löschen`}
                        title={
                          spec.blocks.length <= limits.min
                            ? `Diese Seite benötigt mindestens ${limits.min} Blöcke.`
                            : undefined
                        }
                        onClick={() => setPendingDelete(block.blockId)}
                      >
                        <Trash2 aria-hidden="true" />
                      </Button>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 pl-2">
                      <Badge tone="neutral" size="sm" className="font-mono">
                        {block.blockId}
                      </Badge>
                      <IssueMarker
                        issues={blockIssues}
                        subjectDe={`Block ${PAGE_BLOCK_LABELS_DE[block.type]}`}
                      />
                    </div>
                  </div>
                ),
              };
            })}
          />
        </nav>

        <section
          aria-label="Bearbeiten"
          className={cn('flex min-w-0 flex-col gap-6', pane !== 'editor' && 'max-md:hidden')}
        >
          {showSettings ? (
            <Section heading="Seiteneinstellungen" headingLevel={3}>
              <div className="flex flex-col gap-4">
                <TextControl
                  label="Titel der Seite"
                  value={spec.title}
                  maxLength={200}
                  disabled={disabled}
                  onChange={(title) => update({ ...spec, title } as PageDocumentSpec)}
                />
                <TextControl
                  label="URL-Kürzel"
                  hint="Kleinbuchstaben, Ziffern und Bindestriche."
                  value={spec.slug}
                  maxLength={80}
                  disabled={disabled}
                  onChange={(slug) =>
                    update({
                      ...spec,
                      slug: slug.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
                    } as PageDocumentSpec)
                  }
                />
                <TextControl
                  label="Meta-Titel"
                  value={spec.seo.metaTitle}
                  maxLength={70}
                  disabled={disabled}
                  onChange={(metaTitle) =>
                    update({ ...spec, seo: { ...spec.seo, metaTitle } } as PageDocumentSpec)
                  }
                />
                <TextControl
                  label="Meta-Beschreibung"
                  value={spec.seo.metaDescription}
                  maxLength={180}
                  disabled={disabled}
                  onChange={(metaDescription) =>
                    update({ ...spec, seo: { ...spec.seo, metaDescription } } as PageDocumentSpec)
                  }
                />
                <SelectControl
                  label="Indexierung durch Suchmaschinen"
                  value={spec.seo.noindex ? 'noindex' : 'index'}
                  disabled={disabled}
                  hint="Bezahlte Funnel-Seiten werden standardmäßig nicht indexiert."
                  options={[
                    { value: 'noindex', labelDe: 'Nicht indexieren (Standard für Werbeseiten)' },
                    { value: 'index', labelDe: 'Indexieren erlauben' },
                  ]}
                  onChange={(value) =>
                    update({
                      ...spec,
                      seo: { ...spec.seo, noindex: value === 'noindex' },
                    } as PageDocumentSpec)
                  }
                />

                {isHybrid(spec) ? (
                  <FormRefEditor
                    form={spec.form}
                    availableForms={availableForms}
                    disabled={disabled}
                    anchorOptions={spec.blocks.map((block) => ({
                      blockId: block.blockId,
                      labelDe: PAGE_BLOCK_LABELS_DE[block.type],
                    }))}
                    onChange={(next) => update(updateEmbeddedForm(spec, () => next))}
                  />
                ) : null}
              </div>
            </Section>
          ) : null}

          {!showSettings && selectedBlock ? (
            <Section
              heading={PAGE_BLOCK_LABELS_DE[selectedBlock.type]}
              headingLevel={3}
              description="Alle Inhalte dieses Blocks. Markup, Skripte und Stile sind im Dokument nicht zulässig."
            >
              <BlockEditor
                spec={spec}
                block={selectedBlock}
                issues={issuesFor(
                  issues,
                  ...blockTokens(
                    selectedBlock.blockId,
                    spec.blocks.findIndex((entry) => entry.blockId === selectedBlock.blockId),
                  ),
                )}
                disabled={disabled}
                availableForms={availableForms}
                onSpecChange={update}
              />
            </Section>
          ) : null}

          {!showSettings && !selectedBlock ? (
            <p className="text-sm text-muted-foreground">
              Wählen Sie links einen Block aus oder legen Sie einen neuen an.
            </p>
          ) : null}
        </section>

        <section
          aria-label="Vorschau"
          className={cn(
            'flex min-w-0 flex-col gap-4 xl:sticky xl:top-20 xl:self-start',
            pane !== 'preview' && 'max-md:hidden',
            'lg:col-span-2 xl:col-span-1',
          )}
        >
          <PagePreview
            spec={spec}
            noteDe={published ? 'Veröffentlichte Version' : `Entwurf v${version}`}
          />
        </section>
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title="Block löschen"
        description="Der Block wird von der Seite entfernt. Sprungpunkte, die auf ihn zeigen, werden anschließend als Hinweis angezeigt."
        confirmLabel="Block löschen"
        preview={
          <p className="text-sm">
            {`Block: ${
              spec.blocks.find((block) => block.blockId === pendingDelete)?.type ?? pendingDelete
            } (${pendingDelete})`}
          </p>
        }
        onConfirm={() => {
          if (pendingDelete) {
            const index = spec.blocks.findIndex((block) => block.blockId === pendingDelete);
            const next = deleteBlock(spec, pendingDelete);
            update(next);
            if (selectedBlockId === pendingDelete) {
              setSelectedBlockId(next.blocks[Math.max(0, index - 1)]?.blockId ?? null);
            }
          }
          setPendingDelete(null);
        }}
      />
    </div>
  );
}
