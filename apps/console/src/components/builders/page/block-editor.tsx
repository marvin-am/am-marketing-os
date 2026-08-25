'use client';

import { CONFIDENCE_LABELS, CONFIDENCE_LABELS_DE } from '@am/domain';
import {
  EMBED_MODES,
  internalLink,
  type EmbeddedFormRef,
  type PageBlock,
  type ValidationIssue,
} from '@am/funnel-schema';
import { Badge } from '@am/ui';
import {
  OptionalTextControl,
  SelectControl,
  StringListControl,
  SwitchControl,
  TextareaControl,
  TextControl,
} from '../controls';
import { ItemListEditor } from '../item-list';
import { InlineIssues } from '../issue-views';
import { deriveUniqueKey } from '../keys';
import { EMBED_MODE_LABELS_DE } from '../labels';
import {
  BookingEditor,
  CtaEditor,
  LinkTargetEditor,
  MediaEditor,
  OptionalCtaEditor,
} from '../link-editors';
import type { FormChoice, PageDocumentSpec } from '../port';
import { updateBlock } from './page-ops';

/**
 * The typed editor for one page block.
 *
 * Fifteen block types, one editor per type, each editing exactly the fields its
 * schema declares — that is what keeps the page builder from degenerating into a
 * generic key/value form over JSON. Nothing here accepts markup: the spec
 * refuses it at parse time and the validator reports it as its own issue, so the
 * inputs stay plain text on purpose.
 */

export interface BlockEditorProps {
  spec: PageDocumentSpec;
  block: PageBlock;
  issues: readonly ValidationIssue[];
  disabled: boolean;
  availableForms: readonly FormChoice[];
  onSpecChange: (spec: PageDocumentSpec) => void;
}

export type { FormChoice };

export function BlockEditor({
  spec,
  block,
  issues,
  disabled,
  availableForms,
  onSpecChange,
}: BlockEditorProps) {
  const patch = (updater: (current: PageBlock) => PageBlock) =>
    onSpecChange(updateBlock(spec, block.blockId, updater));

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="neutral" size="sm" className="font-mono">
          {block.blockId}
        </Badge>
      </div>

      <OptionalTextControl
        label="Sprungpunkt"
        hint="Erlaubt Schaltflächen, direkt zu diesem Block zu springen. Leer lassen, wenn nicht verlinkt wird."
        value={block.anchor}
        maxLength={64}
        disabled={disabled}
        onChange={(anchor) =>
          patch((current) => ({
            ...current,
            anchor: anchor ? anchor.toLowerCase().replace(/[^a-z0-9_]/g, '_') : null,
          }))
        }
      />

      <BlockFields
        spec={spec}
        block={block}
        disabled={disabled}
        availableForms={availableForms}
        onSpecChange={onSpecChange}
      />

      <InlineIssues issues={issues} />
    </div>
  );
}

function BlockFields({
  spec,
  block,
  disabled,
  availableForms,
  onSpecChange,
}: Omit<BlockEditorProps, 'issues'>) {
  const patch = (updater: (current: PageBlock) => PageBlock) =>
    onSpecChange(updateBlock(spec, block.blockId, updater));

  switch (block.type) {
    case 'HERO':
      return (
        <>
          <OptionalTextControl
            label="Überzeile"
            value={block.eyebrow}
            maxLength={80}
            disabled={disabled}
            onChange={(eyebrow) =>
              patch((current) => (current.type === 'HERO' ? { ...current, eyebrow } : current))
            }
          />
          <TextControl
            label="Überschrift"
            value={block.headline}
            maxLength={200}
            disabled={disabled}
            onChange={(headline) =>
              patch((current) => (current.type === 'HERO' ? { ...current, headline } : current))
            }
          />
          <OptionalTextControl
            label="Unterzeile"
            value={block.subline}
            maxLength={600}
            disabled={disabled}
            onChange={(subline) =>
              patch((current) => (current.type === 'HERO' ? { ...current, subline } : current))
            }
          />
          <StringListControl
            label="Stichpunkte"
            itemNounDe="Stichpunkt"
            values={block.bullets}
            disabled={disabled}
            onChange={(bullets) =>
              patch((current) => (current.type === 'HERO' ? { ...current, bullets } : current))
            }
          />
          <CtaEditor
            labelDe="Hauptschaltfläche"
            cta={block.primaryCta}
            disabled={disabled}
            onChange={(primaryCta) =>
              patch((current) => (current.type === 'HERO' ? { ...current, primaryCta } : current))
            }
          />
          <OptionalCtaEditor
            labelDe="Zweite Schaltfläche"
            cta={block.secondaryCta}
            disabled={disabled}
            onChange={(secondaryCta) =>
              patch((current) => (current.type === 'HERO' ? { ...current, secondaryCta } : current))
            }
          />
          <MediaEditor
            labelDe="Medium im Hero"
            media={block.media}
            disabled={disabled}
            onChange={(media) =>
              patch((current) => (current.type === 'HERO' ? { ...current, media } : current))
            }
          />
          <OptionalTextControl
            label="Vertrauenshinweis"
            value={block.trustNote}
            maxLength={200}
            disabled={disabled}
            onChange={(trustNote) =>
              patch((current) => (current.type === 'HERO' ? { ...current, trustNote } : current))
            }
          />
        </>
      );

    case 'PROBLEM':
      return (
        <>
          <TextControl
            label="Überschrift"
            value={block.headline}
            maxLength={200}
            disabled={disabled}
            onChange={(headline) =>
              patch((current) => (current.type === 'PROBLEM' ? { ...current, headline } : current))
            }
          />
          <OptionalTextControl
            label="Einleitung"
            value={block.intro}
            maxLength={800}
            disabled={disabled}
            onChange={(intro) =>
              patch((current) => (current.type === 'PROBLEM' ? { ...current, intro } : current))
            }
          />
          <ItemListEditor
            labelDe="Problempunkte"
            itemNounDe="Problempunkt"
            items={block.points}
            min={1}
            max={8}
            disabled={disabled}
            keyOf={(item) => item.key}
            titleOf={(item) => item.title}
            createItem={(taken) => ({
              key: deriveUniqueKey('Neuer Punkt', taken, 'punkt'),
              title: 'Neuer Problempunkt',
              body: 'Beschreiben Sie das Problem konkret.',
            })}
            onChange={(points) =>
              patch((current) => (current.type === 'PROBLEM' ? { ...current, points } : current))
            }
            renderItem={(item, update) => (
              <div className="flex flex-col gap-2">
                <TextControl
                  label="Titel"
                  value={item.title}
                  maxLength={160}
                  disabled={disabled}
                  onChange={(title) => update({ ...item, title })}
                />
                <TextareaControl
                  label="Text"
                  value={item.body}
                  maxLength={800}
                  rows={3}
                  disabled={disabled}
                  onChange={(body) => update({ ...item, body })}
                />
              </div>
            )}
          />
        </>
      );

    case 'BENEFIT':
      return (
        <>
          <TextControl
            label="Überschrift"
            value={block.headline}
            maxLength={200}
            disabled={disabled}
            onChange={(headline) =>
              patch((current) => (current.type === 'BENEFIT' ? { ...current, headline } : current))
            }
          />
          <OptionalTextControl
            label="Einleitung"
            value={block.intro}
            maxLength={800}
            disabled={disabled}
            onChange={(intro) =>
              patch((current) => (current.type === 'BENEFIT' ? { ...current, intro } : current))
            }
          />
          <ItemListEditor
            labelDe="Nutzenpunkte"
            itemNounDe="Nutzen"
            items={block.benefits}
            min={1}
            max={9}
            disabled={disabled}
            keyOf={(item) => item.key}
            titleOf={(item) => item.title}
            createItem={(taken) => ({
              key: deriveUniqueKey('Neuer Nutzen', taken, 'nutzen'),
              title: 'Neuer Nutzen',
              body: 'Was sich für den Betrieb konkret ändert.',
              iconKey: null,
            })}
            onChange={(benefits) =>
              patch((current) => (current.type === 'BENEFIT' ? { ...current, benefits } : current))
            }
            renderItem={(item, update) => (
              <div className="flex flex-col gap-2">
                <TextControl
                  label="Titel"
                  value={item.title}
                  maxLength={160}
                  disabled={disabled}
                  onChange={(title) => update({ ...item, title })}
                />
                <TextareaControl
                  label="Text"
                  value={item.body}
                  maxLength={800}
                  rows={3}
                  disabled={disabled}
                  onChange={(body) => update({ ...item, body })}
                />
              </div>
            )}
          />
        </>
      );

    case 'PROOF':
      return (
        <>
          <TextControl
            label="Überschrift"
            value={block.headline}
            maxLength={200}
            disabled={disabled}
            onChange={(headline) =>
              patch((current) => (current.type === 'PROOF' ? { ...current, headline } : current))
            }
          />
          <ItemListEditor
            labelDe="Belege"
            itemNounDe="Beleg"
            hintDe="Jede Zahl braucht eine Einordnung: Fakt, Indikation oder Hypothese."
            items={block.points}
            min={1}
            max={8}
            disabled={disabled}
            keyOf={(item) => item.key}
            titleOf={(item) => item.label}
            createItem={(taken) => ({
              key: deriveUniqueKey('Neuer Beleg', taken, 'beleg'),
              label: 'Bezeichnung',
              value: 'Wert',
              note: null,
              evidenceItemId: null,
              confidence: 'HYPOTHESIS' as const,
            })}
            onChange={(points) =>
              patch((current) => (current.type === 'PROOF' ? { ...current, points } : current))
            }
            renderItem={(item, update) => (
              <div className="flex flex-col gap-2">
                <TextControl
                  label="Bezeichnung"
                  value={item.label}
                  maxLength={160}
                  disabled={disabled}
                  onChange={(label) => update({ ...item, label })}
                />
                <TextControl
                  label="Wert"
                  value={item.value}
                  maxLength={60}
                  disabled={disabled}
                  onChange={(value) => update({ ...item, value })}
                />
                <SelectControl
                  label="Belastbarkeit"
                  value={item.confidence}
                  disabled={disabled}
                  hint="Ohne hinterlegten Beleg darf eine Zahl höchstens als Indikation oder Hypothese ausgewiesen werden."
                  options={CONFIDENCE_LABELS.map((value) => ({
                    value,
                    labelDe: CONFIDENCE_LABELS_DE[value],
                  }))}
                  onChange={(confidence) => update({ ...item, confidence })}
                />
                <OptionalTextControl
                  label="Anmerkung"
                  value={item.note}
                  maxLength={300}
                  disabled={disabled}
                  onChange={(note) => update({ ...item, note })}
                />
              </div>
            )}
          />
          <OptionalTextControl
            label="Quellenhinweis"
            value={block.sourceNote}
            maxLength={300}
            disabled={disabled}
            onChange={(sourceNote) =>
              patch((current) => (current.type === 'PROOF' ? { ...current, sourceNote } : current))
            }
          />
        </>
      );

    case 'CASE_STUDY':
      return (
        <>
          <TextControl
            label="Überschrift"
            value={block.headline}
            maxLength={200}
            disabled={disabled}
            onChange={(headline) =>
              patch((current) =>
                current.type === 'CASE_STUDY' ? { ...current, headline } : current,
              )
            }
          />
          <TextControl
            label="Kundenbeschreibung"
            hint="Ohne Namensnennung, solange keine Freigabe vorliegt."
            value={block.client}
            maxLength={200}
            disabled={disabled}
            onChange={(client) =>
              patch((current) => (current.type === 'CASE_STUDY' ? { ...current, client } : current))
            }
          />
          <OptionalTextControl
            label="Branche"
            value={block.industry}
            maxLength={120}
            disabled={disabled}
            onChange={(industry) =>
              patch((current) =>
                current.type === 'CASE_STUDY' ? { ...current, industry } : current,
              )
            }
          />
          <TextareaControl
            label="Ausgangslage"
            value={block.challenge}
            maxLength={2000}
            rows={3}
            disabled={disabled}
            onChange={(challenge) =>
              patch((current) =>
                current.type === 'CASE_STUDY' ? { ...current, challenge } : current,
              )
            }
          />
          <TextareaControl
            label="Vorgehen"
            value={block.approach}
            maxLength={2000}
            rows={3}
            disabled={disabled}
            onChange={(approach) =>
              patch((current) =>
                current.type === 'CASE_STUDY' ? { ...current, approach } : current,
              )
            }
          />
          <TextareaControl
            label="Ergebnis"
            value={block.outcome}
            maxLength={2000}
            rows={3}
            disabled={disabled}
            onChange={(outcome) =>
              patch((current) => (current.type === 'CASE_STUDY' ? { ...current, outcome } : current))
            }
          />
          <ItemListEditor
            labelDe="Kennzahlen"
            itemNounDe="Kennzahl"
            items={block.metrics}
            max={6}
            disabled={disabled}
            keyOf={(item) => item.key}
            titleOf={(item) => item.label}
            createItem={(taken) => ({
              key: deriveUniqueKey('Neue Kennzahl', taken, 'kennzahl'),
              label: 'Bezeichnung',
              value: 'Wert',
            })}
            onChange={(metrics) =>
              patch((current) => (current.type === 'CASE_STUDY' ? { ...current, metrics } : current))
            }
            renderItem={(item, update) => (
              <div className="grid gap-2 sm:grid-cols-2">
                <TextControl
                  label="Bezeichnung"
                  value={item.label}
                  maxLength={120}
                  disabled={disabled}
                  onChange={(label) => update({ ...item, label })}
                />
                <TextControl
                  label="Wert"
                  value={item.value}
                  maxLength={120}
                  disabled={disabled}
                  onChange={(value) => update({ ...item, value })}
                />
              </div>
            )}
          />
          <OptionalCtaEditor
            labelDe="Schaltfläche"
            cta={block.cta}
            disabled={disabled}
            onChange={(cta) =>
              patch((current) => (current.type === 'CASE_STUDY' ? { ...current, cta } : current))
            }
          />
        </>
      );

    case 'TESTIMONIAL':
      return (
        <>
          <OptionalTextControl
            label="Überschrift"
            value={block.headline}
            maxLength={200}
            disabled={disabled}
            onChange={(headline) =>
              patch((current) =>
                current.type === 'TESTIMONIAL' ? { ...current, headline } : current,
              )
            }
          />
          <ItemListEditor
            labelDe="Kundenstimmen"
            itemNounDe="Stimme"
            hintDe="Nur wörtliche, freigegebene Zitate."
            items={block.testimonials}
            min={1}
            max={6}
            disabled={disabled}
            keyOf={(item) => item.key}
            titleOf={(item) => item.authorName}
            createItem={(taken) => ({
              key: deriveUniqueKey('Neue Stimme', taken, 'stimme'),
              testimonialId: null,
              quote: 'Wörtliches Zitat.',
              authorName: 'Name der Person',
              authorRole: null,
              company: null,
              media: null,
            })}
            onChange={(testimonials) =>
              patch((current) =>
                current.type === 'TESTIMONIAL' ? { ...current, testimonials } : current,
              )
            }
            renderItem={(item, update) => (
              <div className="flex flex-col gap-2">
                <TextareaControl
                  label="Zitat"
                  value={item.quote}
                  maxLength={1200}
                  rows={3}
                  disabled={disabled}
                  onChange={(quote) => update({ ...item, quote })}
                />
                <TextControl
                  label="Name"
                  value={item.authorName}
                  maxLength={160}
                  disabled={disabled}
                  onChange={(authorName) => update({ ...item, authorName })}
                />
                <div className="grid gap-2 sm:grid-cols-2">
                  <OptionalTextControl
                    label="Rolle"
                    value={item.authorRole}
                    maxLength={160}
                    disabled={disabled}
                    onChange={(authorRole) => update({ ...item, authorRole })}
                  />
                  <OptionalTextControl
                    label="Unternehmen"
                    value={item.company}
                    maxLength={200}
                    disabled={disabled}
                    onChange={(company) => update({ ...item, company })}
                  />
                </div>
              </div>
            )}
          />
        </>
      );

    case 'PROCESS':
      return (
        <>
          <TextControl
            label="Überschrift"
            value={block.headline}
            maxLength={200}
            disabled={disabled}
            onChange={(headline) =>
              patch((current) => (current.type === 'PROCESS' ? { ...current, headline } : current))
            }
          />
          <OptionalTextControl
            label="Einleitung"
            value={block.intro}
            maxLength={600}
            disabled={disabled}
            onChange={(intro) =>
              patch((current) => (current.type === 'PROCESS' ? { ...current, intro } : current))
            }
          />
          <ItemListEditor
            labelDe="Ablaufschritte"
            itemNounDe="Ablaufschritt"
            items={block.steps}
            min={2}
            max={7}
            disabled={disabled}
            keyOf={(item) => item.key}
            titleOf={(item) => item.title}
            createItem={(taken) => ({
              key: deriveUniqueKey('Neuer Schritt', taken, 'schritt'),
              title: 'Neuer Schritt',
              body: 'Was in diesem Schritt passiert.',
              durationNote: null,
            })}
            onChange={(steps) =>
              patch((current) => (current.type === 'PROCESS' ? { ...current, steps } : current))
            }
            renderItem={(item, update) => (
              <div className="flex flex-col gap-2">
                <TextControl
                  label="Titel"
                  value={item.title}
                  maxLength={160}
                  disabled={disabled}
                  onChange={(title) => update({ ...item, title })}
                />
                <TextareaControl
                  label="Text"
                  value={item.body}
                  maxLength={800}
                  rows={2}
                  disabled={disabled}
                  onChange={(body) => update({ ...item, body })}
                />
                <OptionalTextControl
                  label="Dauer"
                  value={item.durationNote}
                  maxLength={80}
                  disabled={disabled}
                  onChange={(durationNote) => update({ ...item, durationNote })}
                />
              </div>
            )}
          />
        </>
      );

    case 'COMPARISON':
      return (
        <>
          <TextControl
            label="Überschrift"
            value={block.headline}
            maxLength={200}
            disabled={disabled}
            onChange={(headline) =>
              patch((current) =>
                current.type === 'COMPARISON' ? { ...current, headline } : current,
              )
            }
          />
          <ItemListEditor
            labelDe="Spalten"
            itemNounDe="Spalte"
            hintDe="Jede Zeile bekommt automatisch genauso viele Zellen wie es Spalten gibt."
            items={block.columns}
            min={2}
            max={4}
            disabled={disabled}
            keyOf={(item) => item.key}
            titleOf={(item) => item.label}
            createItem={(taken) => ({
              key: deriveUniqueKey('Neue Spalte', taken, 'spalte'),
              label: 'Neue Spalte',
              highlight: false,
            })}
            onChange={(columns) =>
              patch((current) =>
                current.type === 'COMPARISON'
                  ? {
                      ...current,
                      columns,
                      rows: current.rows.map((row) => ({
                        ...row,
                        cells: columns.map((_, index) => row.cells[index] ?? '—'),
                      })),
                    }
                  : current,
              )
            }
            renderItem={(item, update) => (
              <div className="flex flex-col gap-2">
                <TextControl
                  label="Spaltentitel"
                  value={item.label}
                  maxLength={120}
                  disabled={disabled}
                  onChange={(label) => update({ ...item, label })}
                />
                <SwitchControl
                  label="Hervorheben"
                  checked={item.highlight}
                  disabled={disabled}
                  onChange={(highlight) => update({ ...item, highlight })}
                />
              </div>
            )}
          />
          <ItemListEditor
            labelDe="Zeilen"
            itemNounDe="Zeile"
            items={block.rows}
            min={1}
            max={12}
            disabled={disabled}
            keyOf={(item) => item.key}
            titleOf={(item) => item.label}
            createItem={(taken) => ({
              key: deriveUniqueKey('Neue Zeile', taken, 'zeile'),
              label: 'Neues Kriterium',
              cells: block.columns.map(() => '—'),
            })}
            onChange={(rows) =>
              patch((current) => (current.type === 'COMPARISON' ? { ...current, rows } : current))
            }
            renderItem={(item, update) => (
              <div className="flex flex-col gap-2">
                <TextControl
                  label="Kriterium"
                  value={item.label}
                  maxLength={160}
                  disabled={disabled}
                  onChange={(label) => update({ ...item, label })}
                />
                {block.columns.map((column, index) => (
                  <TextControl
                    key={column.key}
                    label={`Zelle: ${column.label}`}
                    value={item.cells[index] ?? ''}
                    maxLength={200}
                    disabled={disabled}
                    onChange={(cell) =>
                      update({
                        ...item,
                        cells: block.columns.map((_, position) =>
                          position === index ? cell : (item.cells[position] ?? '—'),
                        ),
                      })
                    }
                  />
                ))}
              </div>
            )}
          />
        </>
      );

    case 'OBJECTION_HANDLING':
      return (
        <>
          <TextControl
            label="Überschrift"
            value={block.headline}
            maxLength={200}
            disabled={disabled}
            onChange={(headline) =>
              patch((current) =>
                current.type === 'OBJECTION_HANDLING' ? { ...current, headline } : current,
              )
            }
          />
          <ItemListEditor
            labelDe="Einwände"
            itemNounDe="Einwand"
            items={block.objections}
            min={1}
            max={8}
            disabled={disabled}
            keyOf={(item) => item.key}
            titleOf={(item) => item.objection}
            createItem={(taken) => ({
              key: deriveUniqueKey('Neuer Einwand', taken, 'einwand'),
              objection: 'Der Einwand in der Sprache der Zielgruppe.',
              response: 'Die ehrliche Antwort.',
            })}
            onChange={(objections) =>
              patch((current) =>
                current.type === 'OBJECTION_HANDLING' ? { ...current, objections } : current,
              )
            }
            renderItem={(item, update) => (
              <div className="flex flex-col gap-2">
                <TextareaControl
                  label="Einwand"
                  value={item.objection}
                  maxLength={300}
                  rows={2}
                  disabled={disabled}
                  onChange={(objection) => update({ ...item, objection })}
                />
                <TextareaControl
                  label="Antwort"
                  value={item.response}
                  maxLength={1200}
                  rows={3}
                  disabled={disabled}
                  onChange={(response) => update({ ...item, response })}
                />
              </div>
            )}
          />
        </>
      );

    case 'FAQ':
      return (
        <>
          <TextControl
            label="Überschrift"
            value={block.headline}
            maxLength={200}
            disabled={disabled}
            onChange={(headline) =>
              patch((current) => (current.type === 'FAQ' ? { ...current, headline } : current))
            }
          />
          <ItemListEditor
            labelDe="Fragen"
            itemNounDe="Frage"
            items={block.items}
            min={1}
            max={15}
            disabled={disabled}
            keyOf={(item) => item.key}
            titleOf={(item) => item.question}
            createItem={(taken) => ({
              key: deriveUniqueKey('Neue Frage', taken, 'frage'),
              faqId: null,
              question: 'Neue Frage?',
              answer: 'Die Antwort.',
            })}
            onChange={(items) =>
              patch((current) => (current.type === 'FAQ' ? { ...current, items } : current))
            }
            renderItem={(item, update) => (
              <div className="flex flex-col gap-2">
                <TextControl
                  label="Frage"
                  value={item.question}
                  maxLength={300}
                  disabled={disabled}
                  onChange={(question) => update({ ...item, question })}
                />
                <TextareaControl
                  label="Antwort"
                  value={item.answer}
                  maxLength={2000}
                  rows={3}
                  disabled={disabled}
                  onChange={(answer) => update({ ...item, answer })}
                />
              </div>
            )}
          />
        </>
      );

    case 'CTA':
      return (
        <>
          <TextControl
            label="Überschrift"
            value={block.headline}
            maxLength={200}
            disabled={disabled}
            onChange={(headline) =>
              patch((current) => (current.type === 'CTA' ? { ...current, headline } : current))
            }
          />
          <OptionalTextControl
            label="Fließtext"
            value={block.body}
            maxLength={800}
            disabled={disabled}
            onChange={(body) =>
              patch((current) => (current.type === 'CTA' ? { ...current, body } : current))
            }
          />
          <CtaEditor
            labelDe="Schaltfläche"
            cta={block.cta}
            disabled={disabled}
            onChange={(cta) =>
              patch((current) => (current.type === 'CTA' ? { ...current, cta } : current))
            }
          />
          <OptionalTextControl
            label="Dringlichkeitshinweis"
            hint="Nur angeben, wenn die Verknappung real ist."
            value={block.urgencyNote}
            maxLength={200}
            disabled={disabled}
            onChange={(urgencyNote) =>
              patch((current) => (current.type === 'CTA' ? { ...current, urgencyNote } : current))
            }
          />
        </>
      );

    case 'TRUST':
      return (
        <>
          <OptionalTextControl
            label="Überschrift"
            value={block.headline}
            maxLength={200}
            disabled={disabled}
            onChange={(headline) =>
              patch((current) => (current.type === 'TRUST' ? { ...current, headline } : current))
            }
          />
          <ItemListEditor
            labelDe="Vertrauensmerkmale"
            itemNounDe="Merkmal"
            items={block.badges}
            max={8}
            disabled={disabled}
            keyOf={(item) => item.key}
            titleOf={(item) => item.label}
            createItem={(taken) => ({
              key: deriveUniqueKey('Neues Merkmal', taken, 'merkmal'),
              label: 'Neues Merkmal',
              note: null,
            })}
            onChange={(badges) =>
              patch((current) => (current.type === 'TRUST' ? { ...current, badges } : current))
            }
            renderItem={(item, update) => (
              <div className="flex flex-col gap-2">
                <TextControl
                  label="Bezeichnung"
                  value={item.label}
                  maxLength={120}
                  disabled={disabled}
                  onChange={(label) => update({ ...item, label })}
                />
                <OptionalTextControl
                  label="Anmerkung"
                  value={item.note}
                  maxLength={200}
                  disabled={disabled}
                  onChange={(note) => update({ ...item, note })}
                />
              </div>
            )}
          />
          <ItemListEditor
            labelDe="Logos"
            itemNounDe="Logo"
            items={block.logos}
            max={12}
            disabled={disabled}
            keyOf={(item) => item.key}
            titleOf={(item) => item.label}
            createItem={(taken) => ({
              key: deriveUniqueKey('Neues Logo', taken, 'logo'),
              label: 'Name des Unternehmens',
              media: null,
            })}
            onChange={(logos) =>
              patch((current) => (current.type === 'TRUST' ? { ...current, logos } : current))
            }
            renderItem={(item, update) => (
              <div className="flex flex-col gap-2">
                <TextControl
                  label="Bezeichnung"
                  value={item.label}
                  maxLength={120}
                  disabled={disabled}
                  onChange={(label) => update({ ...item, label })}
                />
                <MediaEditor
                  labelDe="Logo-Datei"
                  media={item.media}
                  disabled={disabled}
                  onChange={(media) => update({ ...item, media })}
                />
              </div>
            )}
          />
        </>
      );

    case 'BOOKING_CTA':
      return (
        <>
          <TextControl
            label="Überschrift"
            value={block.headline}
            maxLength={200}
            disabled={disabled}
            onChange={(headline) =>
              patch((current) =>
                current.type === 'BOOKING_CTA' ? { ...current, headline } : current,
              )
            }
          />
          <TextareaControl
            label="Fließtext"
            value={block.body}
            maxLength={1200}
            rows={3}
            disabled={disabled}
            onChange={(body) =>
              patch((current) => (current.type === 'BOOKING_CTA' ? { ...current, body } : current))
            }
          />
          <BookingEditor
            booking={block.booking}
            disabled={disabled}
            onChange={(booking) =>
              patch((current) =>
                current.type === 'BOOKING_CTA' ? { ...current, booking } : current,
              )
            }
          />
        </>
      );

    case 'EMBEDDED_CONTACT':
      return (
        <>
          <TextControl
            label="Überschrift"
            value={block.headline}
            maxLength={200}
            disabled={disabled}
            onChange={(headline) =>
              patch((current) =>
                current.type === 'EMBEDDED_CONTACT' ? { ...current, headline } : current,
              )
            }
          />
          <OptionalTextControl
            label="Fließtext"
            value={block.body}
            maxLength={800}
            disabled={disabled}
            onChange={(body) =>
              patch((current) =>
                current.type === 'EMBEDDED_CONTACT' ? { ...current, body } : current,
              )
            }
          />
          <FormRefEditor
            form={block.form}
            availableForms={availableForms}
            disabled={disabled}
            onChange={(form) =>
              patch((current) =>
                current.type === 'EMBEDDED_CONTACT' ? { ...current, form } : current,
              )
            }
          />
        </>
      );

    case 'FOOTER_LEGAL':
      return (
        <>
          <TextControl
            label="Anbieterzeile"
            value={block.companyLine}
            maxLength={300}
            disabled={disabled}
            onChange={(companyLine) =>
              patch((current) =>
                current.type === 'FOOTER_LEGAL' ? { ...current, companyLine } : current,
              )
            }
          />
          <LinkTargetEditor
            labelDe="Impressum"
            target={block.imprintLink}
            disabled={disabled}
            allowAnchor={false}
            onChange={(imprintLink) =>
              patch((current) =>
                current.type === 'FOOTER_LEGAL' ? { ...current, imprintLink } : current,
              )
            }
          />
          <LinkTargetEditor
            labelDe="Datenschutzerklärung"
            target={block.privacyLink}
            disabled={disabled}
            allowAnchor={false}
            onChange={(privacyLink) =>
              patch((current) =>
                current.type === 'FOOTER_LEGAL' ? { ...current, privacyLink } : current,
              )
            }
          />
          <ItemListEditor
            labelDe="Weitere Links"
            itemNounDe="Link"
            items={block.additionalLinks}
            max={6}
            disabled={disabled}
            keyOf={(item) => item.key}
            titleOf={(item) => item.label}
            createItem={(taken) => ({
              key: deriveUniqueKey('Neuer Link', taken, 'link'),
              label: 'Neuer Link',
              target: internalLink('/'),
            })}
            onChange={(additionalLinks) =>
              patch((current) =>
                current.type === 'FOOTER_LEGAL' ? { ...current, additionalLinks } : current,
              )
            }
            renderItem={(item, update) => (
              <div className="flex flex-col gap-2">
                <TextControl
                  label="Beschriftung"
                  value={item.label}
                  maxLength={120}
                  disabled={disabled}
                  onChange={(label) => update({ ...item, label })}
                />
                <LinkTargetEditor
                  labelDe="Ziel"
                  target={item.target}
                  disabled={disabled}
                  onChange={(target) => update({ ...item, target })}
                />
              </div>
            )}
          />
          <StringListControl
            label="Rechtliche Hinweise"
            itemNounDe="Hinweis"
            values={block.disclaimers}
            disabled={disabled}
            onChange={(disclaimers) =>
              patch((current) =>
                current.type === 'FOOTER_LEGAL' ? { ...current, disclaimers } : current,
              )
            }
          />
        </>
      );

    default:
      return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Embedded form reference                                                     */
/* -------------------------------------------------------------------------- */

export interface FormRefEditorProps {
  form: EmbeddedFormRef;
  availableForms: readonly FormChoice[];
  disabled: boolean;
  onChange: (form: EmbeddedFormRef) => void;
  /** Anchor blocks an inline form may be placed after. */
  anchorOptions?: readonly { blockId: string; labelDe: string }[];
}

export function FormRefEditor({
  form,
  availableForms,
  disabled,
  onChange,
  anchorOptions = [],
}: FormRefEditorProps) {
  const known = availableForms.some((entry) => entry.formVersionId === form.formVersionId);

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border p-3">
      <p className="text-sm font-semibold text-foreground">Eingebundenes Formular</p>

      <SelectControl
        label="Formularversion"
        value={form.formVersionId}
        disabled={disabled || availableForms.length === 0}
        hint={
          availableForms.length === 0
            ? 'Es steht keine veröffentlichte Formularversion zur Auswahl. Solange bleibt die bestehende Referenz erhalten.'
            : 'Verweist auf eine konkrete, eingefrorene Formularversion.'
        }
        options={
          known
            ? availableForms.map((entry) => ({
                value: entry.formVersionId,
                labelDe: entry.labelDe,
              }))
            : [
                { value: form.formVersionId, labelDe: `Aktuelle Referenz (${form.formVersionId})` },
                ...availableForms.map((entry) => ({
                  value: entry.formVersionId,
                  labelDe: entry.labelDe,
                })),
              ]
        }
        onChange={(formVersionId) => {
          const picked = availableForms.find((entry) => entry.formVersionId === formVersionId);
          if (!picked) return;
          onChange({ ...form, formId: picked.formId, formVersionId: picked.formVersionId });
        }}
      />

      <SelectControl
        label="Darstellung"
        value={form.mode}
        disabled={disabled}
        options={EMBED_MODES.map((mode) => ({ value: mode, labelDe: EMBED_MODE_LABELS_DE[mode] }))}
        onChange={(mode) => onChange({ ...form, mode })}
      />

      <TextControl
        label="Beschriftung der Schaltfläche"
        hint="Wird nur bei der Darstellung im Overlay verwendet."
        value={form.triggerLabel}
        maxLength={80}
        disabled={disabled || form.mode === 'INLINE'}
        onChange={(triggerLabel) => onChange({ ...form, triggerLabel })}
      />

      {anchorOptions.length > 0 ? (
        <SelectControl
          label="Position des eingebetteten Formulars"
          value={form.anchorBlockId ?? ''}
          disabled={disabled}
          hint="Das Formular erscheint direkt nach dem gewählten Block."
          options={[
            { value: '', labelDe: 'Am Ende der Seite' },
            ...anchorOptions.map((entry) => ({
              value: entry.blockId,
              labelDe: `Nach: ${entry.labelDe}`,
            })),
          ]}
          onChange={(anchorBlockId) =>
            onChange({ ...form, anchorBlockId: anchorBlockId === '' ? null : anchorBlockId })
          }
        />
      ) : null}
    </div>
  );
}
