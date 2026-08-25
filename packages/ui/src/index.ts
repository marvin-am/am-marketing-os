/**
 * `@am/ui` — the A&M Marketing OS design system.
 *
 * Everything the console and the funnel runtime render goes through this
 * package. Two rules keep it honest:
 *
 *   1. No hard-coded colours. Components only reference the tokens declared in
 *      `src/styles/theme.css`, so a brand profile can be swapped at runtime.
 *   2. No colour-only signalling. Every state badge carries an icon and a
 *      German word alongside its tone.
 *
 * Apps must import the stylesheet once, before their own CSS:
 *
 *     @import "@am/ui/styles/theme.css";
 *
 * Every component in `./components` is a client component (`'use client'`).
 * The helpers in `./lib` are pure and safe to call from server components.
 */

/* -------------------------------------------------------------------------- */
/* Helpers (server-safe)                                                       */
/* -------------------------------------------------------------------------- */
export { cn, type ClassValue } from './lib/cn';
export {
  formatCountDe,
  formatDateDe,
  formatDateTimeDe,
  formatFractionDe,
  formatMetricValueDe,
  formatMoneyDe,
  formatMoneyMinorDe,
  formatNumberDe,
  formatPercentDe,
  formatRateDe,
  formatRatioDe,
  isRate,
  metricFormulaDe,
  metricLabelDe,
  NO_VALUE,
  type ValueScale,
} from './lib/format';
export {
  APPROVAL_STATE_LABELS_DE,
  ASSET_REVIEW_STATE_LABELS_DE,
  EXPERIMENT_STATE_LABELS_DE,
  FUNNEL_VERSION_STATE_LABELS_DE,
  RECOMMENDATION_STATE_LABELS_DE,
  resolveStatus,
  STATUS_REGISTRY,
  SUBMISSION_STATE_LABELS_DE,
  SYNC_STATUS_LABELS_DE,
  type StatusDescriptor,
  type StatusIcon,
  type StatusKind,
  type StatusSelector,
} from './lib/status';

/* -------------------------------------------------------------------------- */
/* Primitives                                                                  */
/* -------------------------------------------------------------------------- */
export * from './components/accordion';
export * from './components/alert';
export * from './components/alert-dialog';
export * from './components/avatar';
export * from './components/badge';
export * from './components/breadcrumb';
export * from './components/button';
export * from './components/card';
export * from './components/checkbox';
export * from './components/command';
export * from './components/dialog';
export * from './components/drawer';
export * from './components/dropdown-menu';
export * from './components/input';
export * from './components/label';
export * from './components/popover';
export * from './components/progress';
export * from './components/radio-group';
export * from './components/scroll-area';
export * from './components/select';
export * from './components/separator';
export * from './components/sheet';
export * from './components/skeleton';
export * from './components/slider';
export * from './components/switch';
export * from './components/table';
export * from './components/tabs';
export * from './components/textarea';
export * from './components/toaster';
export * from './components/toggle';
export * from './components/toggle-group';
export * from './components/tooltip';

/* -------------------------------------------------------------------------- */
/* Product components                                                          */
/* -------------------------------------------------------------------------- */
export * from './components/approval-card';
export * from './components/attribution-coverage-badge';
export * from './components/confidence-badge';
export * from './components/confirm-dialog';
export * from './components/data-maturity-badge';
export * from './components/diff-list';
export * from './components/dry-run-notice';
export * from './components/form-field-row';
export * from './components/metric-tile';
export * from './components/page-header';
export * from './components/provider-health-list';
export * from './components/section';
export * from './components/sidebar-nav';
export * from './components/states';
export * from './components/status-badge';
export * from './components/toolbar';

/*
 * Style variants live in their own modules with no 'use client', so a server
 * component can reuse the classes on a native element. Exporting them from the
 * component module would make them client references and crash at render.
 */
export * from './components/alert.variants';
export * from './components/avatar.variants';
export * from './components/badge.variants';
export * from './components/button.variants';
export * from './components/card.variants';
export * from './components/input.variants';
export * from './components/sheet.variants';
export * from './components/toggle.variants';
