'use client';

import * as React from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { ConditionOperator } from '@am/domain';
import {
  getField,
  isConditionGroup,
  isSelectField,
  type ConditionAtom,
  type ConditionGroup,
  type ConditionNode,
  type ConditionValue,
  type MultiStepFormSpec,
  type ValidationIssue,
} from '@am/funnel-schema';
import { cn, Button, Input, Label } from '@am/ui';
import { CheckboxGroupControl, NativeSelect } from '../controls';
import { InlineIssues } from '../issue-views';
import { OPERATOR_LABELS_DE } from '../labels';
import {
  allowedOperators,
  appendConditionNode,
  conditionFieldsAvailable,
  defaultAtom,
  defaultConditionValue,
  groupChildren,
  groupMode,
  setConditionNode,
  setGroupMode,
} from './form-ops';

/**
 * The condition builder.
 *
 * A routing or qualification rule is a tree of atomic comparisons — field,
 * operator, value — and this component is the only way to author one. There is
 * deliberately no expression input anywhere: an operator picks a question from a
 * dropdown, picks one of the eight operators, and picks answers from the
 * options that question actually offers. A condition that references a
 * non-existent option or a question asked later cannot be typed here, because
 * the dropdowns do not contain it.
 */

const ARITY_UNARY: readonly ConditionOperator[] = ['IS_EMPTY', 'IS_NOT_EMPTY'];
const ARITY_LIST: readonly ConditionOperator[] = ['IN', 'NOT_IN'];

function arityOf(operator: ConditionOperator): 'unary' | 'list' | 'scalar' {
  if (ARITY_UNARY.includes(operator)) return 'unary';
  if (ARITY_LIST.includes(operator)) return 'list';
  return 'scalar';
}

export interface ConditionBuilderProps {
  spec: MultiStepFormSpec;
  group: ConditionGroup;
  onChange: (group: ConditionGroup) => void;
  /** Restricts the field list to answers given up to this step; `null` = all. */
  fromStepId: string | null;
  disabled?: boolean;
  issues?: readonly ValidationIssue[];
  className?: string;
}

export function ConditionBuilder({
  spec,
  group,
  onChange,
  fromStepId,
  disabled = false,
  issues = [],
  className,
}: ConditionBuilderProps) {
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <GroupEditor
        spec={spec}
        group={group}
        path={[]}
        depth={0}
        fromStepId={fromStepId}
        disabled={disabled}
        onChangeRoot={onChange}
        root={group}
        onRemoveGroup={null}
      />
      <InlineIssues issues={issues} />
    </div>
  );
}

interface GroupEditorProps {
  spec: MultiStepFormSpec;
  group: ConditionGroup;
  root: ConditionGroup;
  path: number[];
  depth: number;
  fromStepId: string | null;
  disabled: boolean;
  onChangeRoot: (group: ConditionGroup) => void;
  onRemoveGroup: (() => void) | null;
}

function GroupEditor({
  spec,
  group,
  root,
  path,
  depth,
  fromStepId,
  disabled,
  onChangeRoot,
  onRemoveGroup,
}: GroupEditorProps) {
  const modeId = React.useId();
  const children = groupChildren(group);
  const mode = groupMode(group);

  const replaceSelf = (next: ConditionGroup) => {
    onChangeRoot(path.length === 0 ? next : setConditionNode(root, path, next));
  };

  const replaceChild = (index: number, next: ConditionNode | null) => {
    onChangeRoot(setConditionNode(root, [...path, index], next));
  };

  return (
    <div
      className={cn(
        'flex flex-col gap-3 rounded-md border border-border p-3',
        depth > 0 && 'bg-surface-sunken',
      )}
      data-testid={`condition-group-${path.join('-') || 'root'}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Label htmlFor={modeId} className="text-xs font-normal text-muted-foreground">
            Verknüpfung
          </Label>
          <NativeSelect
            id={modeId}
            selectSize="sm"
            className="w-auto"
            value={mode}
            disabled={disabled}
            onChange={(event) =>
              replaceSelf(setGroupMode(group, event.target.value as 'all' | 'any'))
            }
          >
            <option value="all">Alle Bedingungen müssen zutreffen</option>
            <option value="any">Mindestens eine Bedingung muss zutreffen</option>
          </NativeSelect>
        </div>
        {onRemoveGroup ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={onRemoveGroup}
          >
            <Trash2 aria-hidden="true" />
            Untergruppe entfernen
          </Button>
        ) : null}
      </div>

      <ul className="flex flex-col gap-2">
        {children.map((child, index) => (
          <li key={`${path.join('-')}-${index}`}>
            {isConditionGroup(child) ? (
              <GroupEditor
                spec={spec}
                group={child}
                root={root}
                path={[...path, index]}
                depth={depth + 1}
                fromStepId={fromStepId}
                disabled={disabled}
                onChangeRoot={onChangeRoot}
                onRemoveGroup={() => replaceChild(index, null)}
              />
            ) : (
              <AtomRow
                spec={spec}
                atomValue={child}
                fromStepId={fromStepId}
                disabled={disabled}
                canRemove={children.length > 1}
                onChange={(next) => replaceChild(index, next)}
                onRemove={() => replaceChild(index, null)}
                position={index + 1}
              />
            )}
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled}
          onClick={() =>
            onChangeRoot(appendConditionNode(root, path, defaultAtom(spec, fromStepId)))
          }
        >
          <Plus aria-hidden="true" />
          Bedingung hinzufügen
        </Button>
        {depth < 2 ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() =>
              onChangeRoot(
                appendConditionNode(root, path, { all: [defaultAtom(spec, fromStepId)] }),
              )
            }
          >
            <Plus aria-hidden="true" />
            Untergruppe hinzufügen
          </Button>
        ) : null}
      </div>
      {children.length === 0 ? (
        <p className="text-xs text-destructive">
          Eine Bedingung ohne Vergleich ist ungültig. Fügen Sie mindestens eine Bedingung hinzu.
        </p>
      ) : null}
    </div>
  );
}

interface AtomRowProps {
  spec: MultiStepFormSpec;
  atomValue: ConditionAtom;
  fromStepId: string | null;
  disabled: boolean;
  canRemove: boolean;
  position: number;
  onChange: (next: ConditionAtom) => void;
  onRemove: () => void;
}

function AtomRow({
  spec,
  atomValue,
  fromStepId,
  disabled,
  canRemove,
  position,
  onChange,
  onRemove,
}: AtomRowProps) {
  const rowId = React.useId();
  const available = conditionFieldsAvailable(spec, fromStepId);
  const field = getField(spec, atomValue.fieldId);
  const operators = allowedOperators(field);

  /* A field that is no longer available (it moved behind this step) stays
     selectable so the operator can see what the rule currently compares. */
  const options = available.some((entry) => entry.fieldId === atomValue.fieldId)
    ? available
    : field
      ? [field, ...available]
      : available;

  const changeField = (fieldId: string) => {
    const nextField = getField(spec, fieldId);
    const nextOperators = allowedOperators(nextField);
    const operator = nextOperators.includes(atomValue.operator)
      ? atomValue.operator
      : (nextOperators[0] ?? 'EQUALS');
    onChange({ fieldId, operator, value: defaultConditionValue(nextField, operator) });
  };

  const changeOperator = (operator: ConditionOperator) => {
    const keepValue = arityOf(operator) === arityOf(atomValue.operator);
    onChange({
      ...atomValue,
      operator,
      value: keepValue ? atomValue.value : defaultConditionValue(field, operator),
    });
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-surface p-2 sm:flex-row sm:items-end">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Label htmlFor={`${rowId}-field`} className="text-xs font-normal text-muted-foreground">
          {`Bedingung ${position}: Frage`}
        </Label>
        <NativeSelect
          id={`${rowId}-field`}
          selectSize="sm"
          value={atomValue.fieldId}
          disabled={disabled}
          onChange={(event) => changeField(event.target.value)}
        >
          {options.length === 0 ? <option value="">Keine Frage verfügbar</option> : null}
          {options.map((entry) => (
            <option key={entry.fieldId} value={entry.fieldId}>
              {entry.label}
            </option>
          ))}
        </NativeSelect>
      </div>

      <div className="flex w-full flex-col gap-1 sm:w-52">
        <Label htmlFor={`${rowId}-operator`} className="text-xs font-normal text-muted-foreground">
          {`Bedingung ${position}: Vergleich`}
        </Label>
        <NativeSelect
          id={`${rowId}-operator`}
          selectSize="sm"
          value={atomValue.operator}
          disabled={disabled}
          onChange={(event) => changeOperator(event.target.value as ConditionOperator)}
        >
          {operators.map((operator) => (
            <option key={operator} value={operator}>
              {OPERATOR_LABELS_DE[operator]}
            </option>
          ))}
        </NativeSelect>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <ConditionValueEditor
          id={`${rowId}-value`}
          spec={spec}
          atomValue={atomValue}
          disabled={disabled}
          position={position}
          onChange={(value) => onChange({ ...atomValue, value })}
        />
      </div>

      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={disabled || !canRemove}
        aria-label={`Bedingung ${position} entfernen`}
        title={
          canRemove
            ? undefined
            : 'Eine Gruppe benötigt mindestens eine Bedingung. Entfernen Sie stattdessen die ganze Gruppe.'
        }
        onClick={onRemove}
      >
        <Trash2 aria-hidden="true" />
      </Button>
    </div>
  );
}

interface ConditionValueEditorProps {
  id: string;
  spec: MultiStepFormSpec;
  atomValue: ConditionAtom;
  disabled: boolean;
  position: number;
  onChange: (value: ConditionValue) => void;
}

function ConditionValueEditor({
  id,
  spec,
  atomValue,
  disabled,
  position,
  onChange,
}: ConditionValueEditorProps) {
  const field = getField(spec, atomValue.fieldId);
  const arity = arityOf(atomValue.operator);
  const labelDe = `Bedingung ${position}: Wert`;

  if (arity === 'unary') {
    return (
      <>
        <span className="text-xs text-muted-foreground">{labelDe}</span>
        <p className="rounded-md border border-dashed border-border px-2 py-1.5 text-xs text-muted-foreground">
          Dieser Vergleich benötigt keinen Wert.
        </p>
      </>
    );
  }

  if (arity === 'list' && field && isSelectField(field)) {
    const values = Array.isArray(atomValue.value) ? atomValue.value : [];
    return (
      <CheckboxGroupControl
        label={labelDe}
        values={values}
        disabled={disabled}
        options={field.options.map((option) => ({
          value: option.optionId,
          labelDe: option.label,
        }))}
        onChange={(next) => onChange(next)}
      />
    );
  }

  if (field && isSelectField(field)) {
    const current = typeof atomValue.value === 'string' ? atomValue.value : '';
    return (
      <>
        <Label htmlFor={id} className="text-xs font-normal text-muted-foreground">
          {labelDe}
        </Label>
        <NativeSelect
          id={id}
          selectSize="sm"
          value={current}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        >
          {field.options.map((option) => (
            <option key={option.optionId} value={option.optionId}>
              {option.label}
            </option>
          ))}
        </NativeSelect>
      </>
    );
  }

  if (field && (field.type === 'BOOLEAN' || field.type === 'CONSENT')) {
    return (
      <>
        <Label htmlFor={id} className="text-xs font-normal text-muted-foreground">
          {labelDe}
        </Label>
        <NativeSelect
          id={id}
          selectSize="sm"
          value={atomValue.value === true || atomValue.value === 'true' ? 'true' : 'false'}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value === 'true')}
        >
          <option value="true">
            {field.type === 'BOOLEAN' ? field.trueLabel : 'Zugestimmt'}
          </option>
          <option value="false">
            {field.type === 'BOOLEAN' ? field.falseLabel : 'Nicht zugestimmt'}
          </option>
        </NativeSelect>
      </>
    );
  }

  const numeric = field?.type === 'NUMBER' || field?.type === 'RANGE';
  return (
    <>
      <Label htmlFor={id} className="text-xs font-normal text-muted-foreground">
        {labelDe}
      </Label>
      <Input
        id={id}
        inputSize="sm"
        type={numeric ? 'number' : 'text'}
        value={
          atomValue.value === null || Array.isArray(atomValue.value)
            ? ''
            : String(atomValue.value)
        }
        disabled={disabled}
        onChange={(event) =>
          onChange(numeric ? Number(event.target.value) : event.target.value)
        }
      />
    </>
  );
}
