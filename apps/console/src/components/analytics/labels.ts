import type { FunnelKind } from '@am/domain';

/** German funnel-kind labels used across the analytics screens. */
export const FUNNEL_KIND_LABELS_DE: Readonly<Record<FunnelKind, string>> = {
  LANDING_PAGE: 'Landingpage',
  MULTI_STEP_FORM: 'Multi-Step-Formular',
  HYBRID: 'Hybrid',
};

/** Sentinel for "no filter applied" — Radix selects reject an empty value. */
export const ALL_FILTER_VALUE = '__alle__';
