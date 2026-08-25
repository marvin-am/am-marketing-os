import { describe, expect, it } from 'vitest';
import { DomainError } from '@am/domain';
import {
  CURRENT_KEY_VERSION,
  decrypt,
  decryptJson,
  encrypt,
  encryptJson,
  generateEncryptionKey,
  identityHash,
  isEncryptionConfigured,
  loadKeyring,
  safeEqual,
  sha256Hex,
} from './crypto';

const KEY = 'Yh8n2Qw9pR4tL7vX1zA5sD3fG6jK0mNbVcXzQwErTyU=';
const OTHER_KEY = 'ZmFrZUtleUZvclJvdGF0aW9uVGVzdGluZzEyMzQ1Njc=';

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { APP_ENCRYPTION_KEY: KEY, ...overrides } as NodeJS.ProcessEnv;
}

describe('crypto', () => {
  it('round-trips a UTF-8 string with umlauts', () => {
    const keyring = loadKeyring(env());
    const plaintext = 'Geschäftsführer, Jörg Müller, Straße 12';
    const envelope = encrypt(plaintext, { keyring });

    expect(envelope.algorithm).toBe('AES-256-GCM');
    expect(envelope.key_version).toBe(CURRENT_KEY_VERSION);
    expect(envelope.ciphertext).not.toContain('Müller');
    expect(decrypt(envelope, { keyring })).toBe(plaintext);
  });

  it('round-trips JSON', () => {
    const keyring = loadKeyring(env());
    const value = { vorname: 'Sabine', email: 's.brehme@metallbau-brehme.de', telefon: '+4915112345678' };
    const envelope = encryptJson(value, { keyring });
    expect(decryptJson(envelope, { keyring })).toEqual(value);
  });

  it('produces a different ciphertext every time (random IV)', () => {
    const keyring = loadKeyring(env());
    const a = encrypt('same input', { keyring });
    const b = encrypt('same input', { keyring });
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(decrypt(a, { keyring })).toBe(decrypt(b, { keyring }));
  });

  it('binds the AAD, so a ciphertext moved to another row fails to decrypt', () => {
    const keyring = loadKeyring(env());
    const envelope = encrypt('geheim', { keyring, aad: 'submission-a' });
    expect(decrypt(envelope, { keyring, aad: 'submission-a' })).toBe('geheim');
    expect(() => decrypt(envelope, { keyring, aad: 'submission-b' })).toThrow(DomainError);
  });

  it('rejects a tampered auth tag', () => {
    const keyring = loadKeyring(env());
    const envelope = encrypt('geheim', { keyring });
    const tampered = { ...envelope, auth_tag: Buffer.alloc(16, 7).toString('base64') };
    expect(() => decrypt(tampered, { keyring })).toThrow(DomainError);
  });

  describe('missing or invalid key', () => {
    it('throws a German DomainError when APP_ENCRYPTION_KEY is absent', () => {
      expect(() => loadKeyring({} as NodeJS.ProcessEnv)).toThrow(DomainError);
      try {
        loadKeyring({} as NodeJS.ProcessEnv);
      } catch (error) {
        const domainError = error as DomainError;
        expect(domainError.code).toBe('PROVIDER_NOT_CONFIGURED');
        expect(domainError.messageDe).toContain('APP_ENCRYPTION_KEY ist nicht gesetzt');
        expect(domainError.messageDe).toContain('32-Byte-Schlüssel');
      }
    });

    it('throws when the key is the wrong length', () => {
      expect(() => loadKeyring(env({ APP_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') }))).toThrow(
        /32 Byte/,
      );
    });

    it('treats an empty string as missing', () => {
      expect(() => loadKeyring(env({ APP_ENCRYPTION_KEY: '   ' }))).toThrow(DomainError);
    });

    it('reports configuration status without throwing', () => {
      expect(isEncryptionConfigured(env())).toBe(true);
      expect(isEncryptionConfigured({} as NodeJS.ProcessEnv)).toBe(false);
    });
  });

  describe('key rotation', () => {
    it('decrypts historical ciphertext with a retired key', () => {
      const oldKeyring = loadKeyring(env({ APP_ENCRYPTION_KEY: OTHER_KEY, APP_ENCRYPTION_KEY_VERSION: '1' }));
      const historical = encrypt('alter Datensatz', { keyring: oldKeyring });
      expect(historical.key_version).toBe(1);

      const rotated = loadKeyring(
        env({ APP_ENCRYPTION_KEY: KEY, APP_ENCRYPTION_KEY_VERSION: '2', APP_ENCRYPTION_KEY_V1: OTHER_KEY }),
      );
      expect(rotated.currentVersion).toBe(2);
      expect(decrypt(historical, { keyring: rotated })).toBe('alter Datensatz');
      expect(encrypt('neuer Datensatz', { keyring: rotated }).key_version).toBe(2);
    });

    it('fails clearly when the ciphertext names a key version we do not hold', () => {
      const keyring = loadKeyring(env());
      const envelope = { ...encrypt('x', { keyring }), key_version: 9 };
      expect(() => decrypt(envelope, { keyring })).toThrow(/Schlüsselversion 9/);
    });
  });

  describe('hashing', () => {
    it('identityHash is deterministic and normalises case and whitespace', () => {
      const keyring = loadKeyring(env());
      const a = identityHash('  M.Karsten@Elektro-Karsten.DE ', { keyring });
      const b = identityHash('m.karsten@elektro-karsten.de', { keyring });
      expect(a).toBe(b);
      expect(a).toHaveLength(64);
    });

    it('identityHash is salted with the key, so two workspaces do not collide', () => {
      const one = identityHash('a@b.de', { keyring: loadKeyring(env()) });
      const two = identityHash('a@b.de', { keyring: loadKeyring(env({ APP_ENCRYPTION_KEY: OTHER_KEY })) });
      expect(one).not.toBe(two);
    });

    it('sha256Hex matches the well-known digest', () => {
      expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    });

    it('safeEqual compares without leaking length via early return', () => {
      expect(safeEqual('token', 'token')).toBe(true);
      expect(safeEqual('token', 'tokeN')).toBe(false);
      expect(safeEqual('token', 'longer-token')).toBe(false);
    });
  });

  it('generateEncryptionKey produces a usable key', () => {
    const key = generateEncryptionKey();
    expect(Buffer.from(key, 'base64')).toHaveLength(32);
    const keyring = loadKeyring(env({ APP_ENCRYPTION_KEY: key }));
    expect(decrypt(encrypt('ok', { keyring }), { keyring })).toBe('ok');
  });
});
