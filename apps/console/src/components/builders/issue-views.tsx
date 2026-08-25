'use client';

import { AlertTriangle, CheckCircle2, OctagonAlert } from 'lucide-react';
import { cn, Alert, AlertDescription, AlertTitle, Badge } from '@am/ui';
import { errorsOf, warningsOf, type ValidationIssue } from '@am/funnel-schema';
import { countIssues, issueSummaryTextDe, worstSeverity } from './issues';

/**
 * Rendering for the issues `validateFormSpec` / `validatePageSpec` return.
 *
 * The validator already speaks German — `pathDe` names the place, `messageDe`
 * explains the problem — so nothing here translates or rewrites. It only
 * decides where an issue appears: inline next to the offending control, as a
 * marker on a list row, and once more in the persistent summary so an operator
 * can see everything that is still open without hunting through panes.
 */

export interface InlineIssuesProps {
  issues: readonly ValidationIssue[];
  className?: string;
  id?: string;
}

/** The issues belonging to one control, rendered directly beneath it. */
export function InlineIssues({ issues, className, id }: InlineIssuesProps) {
  if (issues.length === 0) return null;

  return (
    <ul id={id} className={cn('flex flex-col gap-1', className)}>
      {issues.map((issue, index) => {
        const isError = issue.severity === 'ERROR';
        const Icon = isError ? OctagonAlert : AlertTriangle;
        return (
          <li
            key={`${issue.code}-${issue.pathDe}-${index}`}
            data-severity={issue.severity}
            className={cn(
              'flex items-start gap-1.5 text-xs leading-relaxed',
              isError ? 'text-destructive' : 'text-warning',
            )}
          >
            <Icon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            <span>
              <span className="sr-only">{isError ? 'Fehler: ' : 'Warnung: '}</span>
              {issue.messageDe}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export interface IssueMarkerProps {
  issues: readonly ValidationIssue[];
  className?: string;
  /** German noun for the element, used in the screen-reader text. */
  subjectDe: string;
}

/** Compact marker for a list row: never colour alone, always a word and a count. */
export function IssueMarker({ issues, subjectDe, className }: IssueMarkerProps) {
  const severity = worstSeverity(issues);
  if (!severity) return null;
  const { errors, warnings } = countIssues(issues);
  const count = severity === 'ERROR' ? errors : warnings;
  const wordDe = severity === 'ERROR' ? 'Fehler' : 'Warnung';

  return (
    <Badge
      tone={severity === 'ERROR' ? 'destructive' : 'warning'}
      className={cn('shrink-0 gap-1', className)}
      title={issues.map((issue) => issue.messageDe).join('\n')}
    >
      {severity === 'ERROR' ? (
        <OctagonAlert aria-hidden="true" className="size-3" />
      ) : (
        <AlertTriangle aria-hidden="true" className="size-3" />
      )}
      <span aria-hidden="true">{count}</span>
      <span className="sr-only">{`${subjectDe}: ${count} ${wordDe}`}</span>
    </Badge>
  );
}

export interface IssueSummaryPanelProps {
  issues: readonly ValidationIssue[];
  /** German heading, e.g. „Offene Hinweise zum Formular“. */
  titleDe: string;
  className?: string;
}

/**
 * The persistent summary. Always rendered — a clean document says so explicitly
 * rather than showing nothing, which reads as "not checked yet".
 */
export function IssueSummaryPanel({ issues, titleDe, className }: IssueSummaryPanelProps) {
  const errors = errorsOf(issues);
  const warnings = warningsOf(issues);
  const tone = errors.length > 0 ? 'destructive' : warnings.length > 0 ? 'warning' : 'success';

  return (
    <Alert
      tone={tone}
      icon={
        tone === 'success' ? (
          <CheckCircle2 aria-hidden="true" />
        ) : tone === 'destructive' ? (
          <OctagonAlert aria-hidden="true" />
        ) : (
          <AlertTriangle aria-hidden="true" />
        )
      }
      className={className}
      data-testid="issue-summary"
    >
      <AlertTitle>{titleDe}</AlertTitle>
      <AlertDescription>
        <p>{issueSummaryTextDe(issues)}</p>
        {issues.length > 0 ? (
          <ul className="mt-2 flex max-h-56 flex-col gap-1.5 overflow-y-auto pr-1">
            {[...errors, ...warnings].map((issue, index) => (
              <li key={`${issue.code}-${issue.pathDe}-${index}`} className="text-xs leading-relaxed">
                <span className="font-medium">
                  {issue.severity === 'ERROR' ? 'Fehler' : 'Warnung'} · {issue.pathDe}
                </span>
                <br />
                <span>{issue.messageDe}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
