import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Time                                                                        */
/* -------------------------------------------------------------------------- */

/** ISO-8601 timestamp in UTC. Every persisted timestamp is `timestamptz`. */
export const isoTimestampSchema = z.iso.datetime({ offset: true });
export type IsoTimestamp = string;

export const isoDateSchema = z.iso.date();
export type IsoDate = string;

export function nowIso(): IsoTimestamp {
  return new Date().toISOString();
}

/* -------------------------------------------------------------------------- */
/* Locale / money                                                              */
/* -------------------------------------------------------------------------- */

export const localeSchema = z.literal('de-DE');
export type Locale = z.infer<typeof localeSchema>;

/** ISO-4217 currency code. */
export const currencySchema = z
  .string()
  .length(3)
  .regex(/^[A-Z]{3}$/, 'Erwartet einen ISO-4217-Code, z. B. EUR');
export type Currency = z.infer<typeof currencySchema>;

/**
 * Money is stored in minor units (cents) as an integer. Floating point euros
 * are never persisted — rounding drift across thousands of insights rows would
 * quietly corrupt ROAS.
 */
export const moneySchema = z.object({
  amountMinor: z.number().int(),
  currency: currencySchema,
});
export type Money = z.infer<typeof moneySchema>;

export function money(amountMinor: number, currency: Currency = 'EUR'): Money {
  return { amountMinor: Math.round(amountMinor), currency };
}

export function moneyFromMajor(amountMajor: number, currency: Currency = 'EUR'): Money {
  return { amountMinor: Math.round(amountMajor * 100), currency };
}

export function toMajor(m: Money): number {
  return m.amountMinor / 100;
}

export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) {
    throw new Error(`Cannot add ${a.currency} and ${b.currency}`);
  }
  return { amountMinor: a.amountMinor + b.amountMinor, currency: a.currency };
}

export function formatMoneyDe(m: Money): string {
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: m.currency,
  }).format(toMajor(m));
}

/* -------------------------------------------------------------------------- */
/* Contact primitives                                                          */
/* -------------------------------------------------------------------------- */

export const emailSchema = z.email().max(254);

/**
 * Normalises an e-mail for identity resolution: trims, lowercases and strips
 * the display name. Deliberately does NOT strip gmail dots — two different
 * HubSpot contacts may legitimately exist and silently merging them would
 * corrupt attribution.
 */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** German postcode: exactly five digits. */
export const postcodeDeSchema = z
  .string()
  .regex(/^\d{5}$/, 'Bitte geben Sie eine gültige fünfstellige Postleitzahl ein.');

export const phoneSchema = z.string().min(5).max(32);

/**
 * Best-effort E.164 normalisation for German input formats. Returns `null` when
 * the input cannot be normalised with confidence — callers must then keep the
 * raw value and mark the number as unnormalised rather than guessing.
 */
export function normalizePhoneE164(raw: string, defaultCountry: '+49' = '+49'): string | null {
  const cleaned = raw.replace(/[\s\-()./]/g, '');
  if (cleaned.length === 0) return null;

  if (cleaned.startsWith('+')) {
    const digits = cleaned.slice(1);
    if (!/^\d{7,15}$/.test(digits)) return null;
    return `+${digits}`;
  }
  if (cleaned.startsWith('00')) {
    const digits = cleaned.slice(2);
    if (!/^\d{7,15}$/.test(digits)) return null;
    return `+${digits}`;
  }
  if (cleaned.startsWith('0')) {
    const national = cleaned.slice(1);
    if (!/^\d{6,14}$/.test(national)) return null;
    return `${defaultCountry}${national}`;
  }
  if (/^\d{6,14}$/.test(cleaned)) {
    return `${defaultCountry}${cleaned}`;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* URLs                                                                        */
/* -------------------------------------------------------------------------- */

export const httpsUrlSchema = z
  .url()
  .refine((u) => u.startsWith('https://') || u.startsWith('http://localhost'), {
    message: 'Nur HTTPS-URLs sind zulässig (Ausnahme: localhost).',
  });

/** Freemail domains never trigger automatic company creation (spec §22). */
export const FREEMAIL_DOMAINS: readonly string[] = [
  'gmail.com',
  'googlemail.com',
  'web.de',
  'gmx.de',
  'gmx.net',
  'gmx.at',
  'gmx.ch',
  't-online.de',
  'outlook.com',
  'outlook.de',
  'hotmail.com',
  'hotmail.de',
  'live.com',
  'live.de',
  'yahoo.com',
  'yahoo.de',
  'icloud.com',
  'me.com',
  'aol.com',
  'freenet.de',
  'mail.de',
  'posteo.de',
  'protonmail.com',
  'proton.me',
];

export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at < 0 || at === email.length - 1) return null;
  return email.slice(at + 1).toLowerCase();
}

export function isFreemailDomain(domain: string): boolean {
  return FREEMAIL_DOMAINS.includes(domain.toLowerCase());
}

/* -------------------------------------------------------------------------- */
/* Text                                                                        */
/* -------------------------------------------------------------------------- */

export const shortTextSchema = z.string().trim().min(1).max(200);
export const mediumTextSchema = z.string().trim().min(1).max(1000);
export const longTextSchema = z.string().trim().min(1).max(8000);

export const slugSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Nur Kleinbuchstaben, Ziffern und Bindestriche.');

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/* -------------------------------------------------------------------------- */
/* Hashing                                                                     */
/* -------------------------------------------------------------------------- */

/** Lowercase hex SHA-256. Used for content hashes, dedup keys and CAPI ids. */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Deterministic, non-cryptographic 32-bit hash (FNV-1a). Used only where a fast
 * stable bucket is needed — never for security or dedup keys.
 */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
