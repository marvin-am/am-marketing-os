/**
 * AES-256-GCM envelope encryption for lead PII and provider tokens.
 *
 * The key lives in `APP_ENCRYPTION_KEY` (base64, exactly 32 bytes). Every
 * ciphertext carries the `key_version` it was written with, so a rotation adds a
 * key rather than requiring a rewrite of historical rows.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { DomainError } from '@am/domain';

export const ENCRYPTION_ALGORITHM = 'AES-256-GCM' as const;
const NODE_ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

/** Current key version. Bump when `APP_ENCRYPTION_KEY` is rotated. */
export const CURRENT_KEY_VERSION = 1;

/** The stored envelope. All binary fields are base64 at the boundary. */
export interface EncryptedEnvelope {
  algorithm: typeof ENCRYPTION_ALGORITHM;
  key_version: number;
  iv: string;
  auth_tag: string;
  ciphertext: string;
}

export interface EncryptionKeyring {
  /** version → 32-byte key */
  keys: Map<number, Buffer>;
  currentVersion: number;
}

function missingKeyError(): DomainError {
  return new DomainError('PROVIDER_NOT_CONFIGURED', {
    messageDe:
      'APP_ENCRYPTION_KEY ist nicht gesetzt. Personenbezogene Daten können ohne Schlüssel weder ' +
      'verschlüsselt noch entschlüsselt werden. Hinterlegen Sie einen base64-kodierten 32-Byte-Schlüssel.',
    details: { variable: 'APP_ENCRYPTION_KEY' },
  });
}

function invalidKeyError(reason: string): DomainError {
  return new DomainError('PROVIDER_NOT_CONFIGURED', {
    messageDe: `APP_ENCRYPTION_KEY ist ungültig: ${reason}. Erwartet wird ein base64-kodierter 32-Byte-Schlüssel.`,
    details: { variable: 'APP_ENCRYPTION_KEY', reason },
  });
}

function parseKey(raw: string): Buffer {
  let key: Buffer;
  try {
    key = Buffer.from(raw.trim(), 'base64');
  } catch {
    throw invalidKeyError('kein gültiges base64');
  }
  if (key.byteLength !== KEY_BYTES) {
    throw invalidKeyError(`${key.byteLength} statt ${KEY_BYTES} Byte`);
  }
  return key;
}

/**
 * Builds a keyring from the environment.
 *
 * `APP_ENCRYPTION_KEY` holds the current key. Retired keys stay readable through
 * `APP_ENCRYPTION_KEY_V<n>` so a rotation never orphans historical ciphertext.
 */
export function loadKeyring(env: NodeJS.ProcessEnv = process.env): EncryptionKeyring {
  const raw = env.APP_ENCRYPTION_KEY;
  if (!raw || raw.trim() === '') throw missingKeyError();

  const currentVersion = Number.parseInt(env.APP_ENCRYPTION_KEY_VERSION ?? '', 10);
  const version = Number.isFinite(currentVersion) && currentVersion >= 1 ? currentVersion : CURRENT_KEY_VERSION;

  const keys = new Map<number, Buffer>();
  keys.set(version, parseKey(raw));

  for (const [name, value] of Object.entries(env)) {
    const match = /^APP_ENCRYPTION_KEY_V(\d+)$/.exec(name);
    if (!match || !value) continue;
    const legacyVersion = Number.parseInt(match[1], 10);
    if (!Number.isFinite(legacyVersion) || keys.has(legacyVersion)) continue;
    keys.set(legacyVersion, parseKey(value));
  }

  return { keys, currentVersion: version };
}

function keyFor(keyring: EncryptionKeyring, version: number): Buffer {
  const key = keyring.keys.get(version);
  if (!key) {
    throw new DomainError('PROVIDER_NOT_CONFIGURED', {
      messageDe: `Für Schlüsselversion ${version} ist kein Schlüssel hinterlegt. Setzen Sie APP_ENCRYPTION_KEY_V${version}.`,
      details: { keyVersion: version },
    });
  }
  return key;
}

/**
 * Encrypts a UTF-8 string. `aad` is bound into the authentication tag — pass the
 * submission id so a ciphertext moved to another row fails to decrypt.
 */
export function encrypt(
  plaintext: string,
  options: { keyring?: EncryptionKeyring; aad?: string } = {},
): EncryptedEnvelope {
  const keyring = options.keyring ?? loadKeyring();
  const version = keyring.currentVersion;
  const key = keyFor(keyring, version);

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(NODE_ALGORITHM, key, iv, { authTagLength: AUTH_TAG_BYTES });
  if (options.aad) cipher.setAAD(Buffer.from(options.aad, 'utf8'));

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  return {
    algorithm: ENCRYPTION_ALGORITHM,
    key_version: version,
    iv: iv.toString('base64'),
    auth_tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

export function decrypt(
  envelope: EncryptedEnvelope,
  options: { keyring?: EncryptionKeyring; aad?: string } = {},
): string {
  const keyring = options.keyring ?? loadKeyring();
  const key = keyFor(keyring, envelope.key_version);

  if (envelope.algorithm !== ENCRYPTION_ALGORITHM) {
    throw new DomainError('INTERNAL', {
      messageDe: `Unbekanntes Verschlüsselungsverfahren: ${envelope.algorithm}.`,
      details: { algorithm: envelope.algorithm },
    });
  }

  try {
    const decipher = createDecipheriv(NODE_ALGORITHM, key, Buffer.from(envelope.iv, 'base64'), {
      authTagLength: AUTH_TAG_BYTES,
    });
    decipher.setAuthTag(Buffer.from(envelope.auth_tag, 'base64'));
    if (options.aad) decipher.setAAD(Buffer.from(options.aad, 'utf8'));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch (cause) {
    throw new DomainError('INTERNAL', {
      messageDe:
        'Die verschlüsselten Daten konnten nicht entschlüsselt werden. Schlüsselversion oder Datensatz stimmen nicht überein.',
      details: { keyVersion: envelope.key_version },
      cause,
    });
  }
}

/** Convenience for the PII record: encrypt a JSON object. */
export function encryptJson(
  value: unknown,
  options: { keyring?: EncryptionKeyring; aad?: string } = {},
): EncryptedEnvelope {
  return encrypt(JSON.stringify(value), options);
}

export function decryptJson<T>(
  envelope: EncryptedEnvelope,
  options: { keyring?: EncryptionKeyring; aad?: string } = {},
): T {
  return JSON.parse(decrypt(envelope, options)) as T;
}

/* -------------------------------------------------------------------------- */
/* Hashing for identity resolution                                             */
/* -------------------------------------------------------------------------- */

/**
 * Salted SHA-256 used for `email_hash` / `phone_hash`. Salted with the
 * encryption key so the hashes are not a rainbow-table lookup away from the
 * plaintext, and deterministic so identity resolution still works.
 */
export function identityHash(value: string, options: { keyring?: EncryptionKeyring } = {}): string {
  const keyring = options.keyring ?? loadKeyring();
  const key = keyFor(keyring, keyring.currentVersion);
  return createHmac('sha256', key).update(value.trim().toLowerCase(), 'utf8').digest('hex');
}

/** Unsalted SHA-256 — content hashes, payload hashes, CAPI user data. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Constant-time comparison for signatures and webhook secrets. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.byteLength !== bufB.byteLength) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Whether encryption is usable at all. Lets DEMO_MODE degrade honestly. */
export function isEncryptionConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    loadKeyring(env);
    return true;
  } catch {
    return false;
  }
}

/** Generates a fresh base64 key. Used by `scripts` and by the tests. */
export function generateEncryptionKey(): string {
  return randomBytes(KEY_BYTES).toString('base64');
}
