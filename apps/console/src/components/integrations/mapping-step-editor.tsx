'use client';

import * as React from 'react';
import type { HubspotMappingDocument } from '@am/hubspot';
import { Button, CheckboxField, FormFieldRow, Input } from '@am/ui';
import { Plus, Trash2 } from 'lucide-react';
import {
  formatStringList,
  parseStringList,
  readBoolean,
  readNumber,
  readRecord,
  readRows,
  readStringList,
  readText,
  setAtPath,
  type MappingFieldDescriptor,
  type MappingOption,
  type MappingSubField,
} from './mapping-fields';

/**
 * Renders the editable fields of one wizard step from `MAPPING_FIELDS`.
 *
 * Values are written straight into a copy of the mapping document, so the step
 * the operator sees and the document that goes to `validateMapping` are the
 * same thing. Nothing here decides what is required — that is the validator's
 * job, and its German issues are rendered by the wizard alongside these fields.
 */

const selectClass =
  'h-9 w-full rounded-md border border-input bg-surface px-2 text-sm text-foreground shadow-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-70';

export interface MappingStepEditorProps {
  fields: readonly MappingFieldDescriptor[];
  document: HubspotMappingDocument;
  onChange: (next: HubspotMappingDocument) => void;
  disabled?: boolean;
}

export function MappingStepEditor({
  fields,
  document: doc,
  onChange,
  disabled = false,
}: MappingStepEditorProps) {
  const write = (path: string, value: unknown) => onChange(setAtPath(doc, path, value));

  return (
    <div className="flex flex-col gap-4">
      {fields.map((field) => (
        <FieldControl
          key={field.path}
          field={field}
          document={doc}
          write={write}
          disabled={disabled}
        />
      ))}
    </div>
  );
}

interface FieldControlProps {
  field: MappingFieldDescriptor;
  document: HubspotMappingDocument;
  write: (path: string, value: unknown) => void;
  disabled: boolean;
}

function FieldControl({ field, document: doc, write, disabled }: FieldControlProps) {
  switch (field.kind) {
    case 'text':
      return (
        <FormFieldRow label={field.labelDe} help={field.helpDe} orientation="horizontal">
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              disabled={disabled}
              placeholder={field.placeholder ?? (field.nullable ? 'nicht hinterlegt' : undefined)}
              value={readText(doc, field.path)}
              onChange={(event) =>
                write(
                  field.path,
                  field.nullable && event.target.value.trim() === '' ? null : event.target.value,
                )
              }
            />
          )}
        </FormFieldRow>
      );

    case 'number':
      return (
        <FormFieldRow label={field.labelDe} help={field.helpDe} orientation="horizontal">
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              type="number"
              disabled={disabled}
              value={String(readNumber(doc, field.path))}
              onChange={(event) => write(field.path, Number(event.target.value) || 0)}
            />
          )}
        </FormFieldRow>
      );

    case 'select':
      return (
        <FormFieldRow label={field.labelDe} help={field.helpDe} orientation="horizontal">
          {({ id, describedBy }) => (
            <select
              id={id}
              aria-describedby={describedBy}
              className={selectClass}
              disabled={disabled}
              value={readText(doc, field.path)}
              onChange={(event) => write(field.path, event.target.value)}
            >
              {(field.options ?? []).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.labelDe}
                </option>
              ))}
            </select>
          )}
        </FormFieldRow>
      );

    case 'boolean':
      return (
        <CheckboxField
          label={field.labelDe}
          description={field.helpDe}
          disabled={disabled}
          checked={readBoolean(doc, field.path)}
          onCheckedChange={(next) => write(field.path, next === true)}
        />
      );

    case 'stringList':
      return (
        <FormFieldRow
          label={field.labelDe}
          help={field.helpDe ?? 'Mehrere Werte mit Komma trennen.'}
          orientation="horizontal"
        >
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              disabled={disabled}
              placeholder="wert-1, wert-2"
              value={formatStringList(readStringList(doc, field.path))}
              onChange={(event) => write(field.path, parseStringList(event.target.value))}
            />
          )}
        </FormFieldRow>
      );

    case 'keyValue':
      return (
        <KeyValueEditor field={field} document={doc} write={write} disabled={disabled} />
      );

    case 'objectList':
      return <ObjectListEditor field={field} document={doc} write={write} disabled={disabled} />;
  }
}

/* -------------------------------------------------------------------------- */
/* Key/value pairs                                                             */
/* -------------------------------------------------------------------------- */

function KeyValueEditor({ field, document: doc, write, disabled }: FieldControlProps) {
  const record = readRecord(doc, field.path);
  const entries = Object.entries(record);

  const replace = (next: [string, string][]) =>
    write(field.path, Object.fromEntries(next.filter(([key]) => key.trim().length > 0)));

  return (
    <fieldset className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <legend className="px-1 text-sm font-medium text-foreground">{field.labelDe}</legend>
      {field.helpDe ? (
        <p className="text-xs leading-relaxed text-muted-foreground">{field.helpDe}</p>
      ) : null}

      {entries.length === 0 ? (
        <p className="text-xs text-muted-foreground">Noch keine Zuordnung hinterlegt.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {entries.map(([key, value], index) => (
            <li key={`${key}-${index}`} className="flex flex-wrap items-end gap-2">
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="text-xs text-muted-foreground">
                  {field.keyLabelDe ?? 'Schlüssel'}
                </span>
                {field.keyOptions ? (
                  <select
                    aria-label={field.keyLabelDe ?? 'Schlüssel'}
                    className={selectClass}
                    disabled={disabled}
                    value={key}
                    onChange={(event) => {
                      const next = [...entries] as [string, string][];
                      next[index] = [event.target.value, value];
                      replace(next);
                    }}
                  >
                    {field.keyOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.labelDe}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Input
                    aria-label={field.keyLabelDe ?? 'Schlüssel'}
                    disabled={disabled}
                    value={key}
                    onChange={(event) => {
                      const next = [...entries] as [string, string][];
                      next[index] = [event.target.value, value];
                      replace(next);
                    }}
                  />
                )}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="text-xs text-muted-foreground">
                  {field.valueLabelDe ?? 'Wert'}
                </span>
                {field.options ? (
                  <select
                    aria-label={field.valueLabelDe ?? 'Wert'}
                    className={selectClass}
                    disabled={disabled}
                    value={value}
                    onChange={(event) => {
                      const next = [...entries] as [string, string][];
                      next[index] = [key, event.target.value];
                      replace(next);
                    }}
                  >
                    {field.options.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.labelDe}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Input
                    aria-label={field.valueLabelDe ?? 'Wert'}
                    disabled={disabled}
                    value={value}
                    onChange={(event) => {
                      const next = [...entries] as [string, string][];
                      next[index] = [key, event.target.value];
                      replace(next);
                    }}
                  />
                )}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={disabled}
                aria-label={`Zuordnung „${key}“ entfernen`}
                onClick={() => replace(entries.filter((_, i) => i !== index) as [string, string][])}
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Button
        variant="secondary"
        size="sm"
        className="self-start"
        disabled={disabled}
        onClick={() => {
          const nextKey = field.keyOptions
            ? (field.keyOptions.find((option) => !(option.value in record))?.value ?? '')
            : '';
          replace([...entries, [nextKey, '']] as [string, string][]);
        }}
      >
        <Plus aria-hidden="true" />
        Zuordnung hinzufügen
      </Button>
    </fieldset>
  );
}

/* -------------------------------------------------------------------------- */
/* Rule lists                                                                  */
/* -------------------------------------------------------------------------- */

function ObjectListEditor({ field, document: doc, write, disabled }: FieldControlProps) {
  const rows = readRows(doc, field.path);
  const subFields = field.subFields ?? [];

  const replace = (next: Record<string, unknown>[]) => write(field.path, next);

  const patchRow = (index: number, key: string, value: unknown) => {
    const next = rows.map((row, i) => (i === index ? { ...row, [key]: value } : row));
    replace(next);
  };

  return (
    <fieldset className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <legend className="px-1 text-sm font-medium text-foreground">{field.labelDe}</legend>
      {field.helpDe ? (
        <p className="text-xs leading-relaxed text-muted-foreground">{field.helpDe}</p>
      ) : null}

      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">Noch keine Regel hinterlegt.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((row, index) => (
            <li
              key={index}
              className="flex flex-col gap-2 rounded-md border border-border bg-surface-sunken p-3"
            >
              <div className="grid gap-2 md:grid-cols-2">
                {subFields.map((subField) => (
                  <SubFieldControl
                    key={subField.key}
                    subField={subField}
                    value={row[subField.key]}
                    disabled={disabled}
                    onChange={(value) => patchRow(index, subField.key, value)}
                  />
                ))}
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="self-end"
                disabled={disabled}
                onClick={() => replace(rows.filter((_, i) => i !== index))}
              >
                <Trash2 aria-hidden="true" />
                Regel entfernen
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Button
        variant="secondary"
        size="sm"
        className="self-start"
        disabled={disabled}
        onClick={() => replace([...rows, { ...(field.newRow ?? {}) }])}
      >
        <Plus aria-hidden="true" />
        Regel hinzufügen
      </Button>
    </fieldset>
  );
}

interface SubFieldControlProps {
  subField: MappingSubField;
  value: unknown;
  disabled: boolean;
  onChange: (value: unknown) => void;
}

function SubFieldControl({ subField, value, disabled, onChange }: SubFieldControlProps) {
  const id = React.useId();

  if (subField.kind === 'boolean') {
    return (
      <CheckboxField
        id={id}
        label={subField.labelDe}
        disabled={disabled}
        checked={value === true}
        onCheckedChange={(next) => onChange(next === true)}
      />
    );
  }

  if (subField.kind === 'select') {
    return (
      <span className="flex flex-col gap-1">
        <label htmlFor={id} className="text-xs text-muted-foreground">
          {subField.labelDe}
        </label>
        <select
          id={id}
          className={selectClass}
          disabled={disabled}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.target.value)}
        >
          {(subField.options ?? ([] as readonly MappingOption[])).map((option) => (
            <option key={option.value} value={option.value}>
              {option.labelDe}
            </option>
          ))}
        </select>
      </span>
    );
  }

  if (subField.kind === 'stringList') {
    return (
      <span className="flex flex-col gap-1">
        <label htmlFor={id} className="text-xs text-muted-foreground">
          {subField.labelDe}
        </label>
        <Input
          id={id}
          disabled={disabled}
          placeholder="wert-1, wert-2"
          value={formatStringList(Array.isArray(value) ? value.map(String) : [])}
          onChange={(event) => onChange(parseStringList(event.target.value))}
        />
      </span>
    );
  }

  return (
    <span className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {subField.labelDe}
      </label>
      <Input
        id={id}
        disabled={disabled}
        placeholder={subField.placeholder}
        value={value === null || value === undefined ? '' : String(value)}
        onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
      />
    </span>
  );
}
