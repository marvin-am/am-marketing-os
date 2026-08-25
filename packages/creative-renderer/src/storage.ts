/**
 * Storage for source motifs and composed renditions.
 *
 * Two implementations behind one interface: an in-memory store for tests and
 * demo mode, and a Supabase-Storage-shaped one that takes an injected client.
 * The client is a *parameter*, never an import — `@am/db` sits above this
 * package in the graph and importing it here would create a cycle.
 *
 * `copyExternal` exists for a specific, real problem: Meta's creative file URLs
 * expire. Historical creatives imported for the learning index have to be copied
 * into our own bucket at import time, or the archive quietly turns into a list
 * of dead links.
 */

import { DomainError, nowIso, type IsoTimestamp } from '@am/domain';
import { sha256Bytes } from './compose';
import { CONTENT_TYPES, type CreativeRendition, type OutputFormat } from './types';

export interface StoredObject {
  bucket: string;
  path: string;
  contentType: string;
  byteLength: number;
  sha256: string;
  createdAt: IsoTimestamp;
  /** Set when the bytes were copied in from a provider URL. */
  sourceUrl: string | null;
}

export interface SignedUrl {
  url: string;
  expiresInSeconds: number;
  expiresAt: IsoTimestamp;
}

export interface PutSourceInput {
  /** Content hash of the motif; also its filename. */
  sha256: string;
  bytes: Uint8Array;
  contentType: string;
  /** Overrides the derived path. */
  path?: string;
  sourceUrl?: string | null;
}

export interface PutRenditionInput {
  rendition: Pick<CreativeRendition, 'renditionKey' | 'conceptKey'>;
  format: OutputFormat;
  bytes: Uint8Array;
  path?: string;
}

export interface CopyExternalInput {
  url: string;
  /** Logical folder inside the bucket, e.g. `meta-historical`. */
  namespace?: string;
  maxBytes?: number;
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof globalThis.fetch;
  signal?: AbortSignal;
}

export interface CreativeStorage {
  putSource(input: PutSourceInput): Promise<StoredObject>;
  putRendition(input: PutRenditionInput): Promise<StoredObject>;
  getSignedUrl(path: string, expiresInSeconds?: number): Promise<SignedUrl>;
  /** Copies a provider-hosted file into our own bucket before its URL expires. */
  copyExternal(input: CopyExternalInput): Promise<StoredObject>;
}

export const DEFAULT_CREATIVE_BUCKET = 'creatives';
export const DEFAULT_SIGNED_URL_SECONDS = 3600;
export const MAX_EXTERNAL_COPY_BYTES = 30 * 1024 * 1024;

const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

export function extensionForContentType(contentType: string): string {
  return EXTENSIONS[contentType.split(';')[0]!.trim().toLowerCase()] ?? 'bin';
}

export function sourcePath(sha256: string, contentType: string, namespace = 'sources'): string {
  return `${namespace}/${sha256.slice(0, 2)}/${sha256}.${extensionForContentType(contentType)}`;
}

export function renditionPath(
  rendition: Pick<CreativeRendition, 'renditionKey' | 'conceptKey'>,
  format: OutputFormat,
): string {
  return `renditions/${rendition.conceptKey}/${rendition.renditionKey}.${format === 'jpeg' ? 'jpg' : 'webp'}`;
}

/* -------------------------------------------------------------------------- */
/* External copy                                                               */
/* -------------------------------------------------------------------------- */

interface FetchedFile {
  bytes: Uint8Array;
  contentType: string;
  sha256: string;
}

/**
 * Downloads and validates a provider file. Any failure throws — a half-copied or
 * unverified asset must never be recorded as if the copy had succeeded.
 */
export async function fetchExternalImage(input: CopyExternalInput): Promise<FetchedFile> {
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch (cause) {
    throw new DomainError('VALIDATION_FAILED', {
      messageDe: 'Die Quell-URL ist ungültig.',
      details: { url: input.url },
      cause,
    });
  }
  if (parsed.protocol !== 'https:') {
    throw new DomainError('VALIDATION_FAILED', {
      messageDe: 'Externe Assets werden nur über HTTPS kopiert.',
      details: { url: input.url },
    });
  }

  const doFetch = input.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new DomainError('PROVIDER_NOT_CONFIGURED', {
      messageDe: 'In dieser Umgebung steht kein fetch zur Verfügung.',
    });
  }

  let response: Response;
  try {
    response = await doFetch(parsed.toString(), { signal: input.signal });
  } catch (cause) {
    throw new DomainError('PROVIDER_ERROR', {
      messageDe: 'Die Datei konnte nicht vom Anbieter geladen werden.',
      details: { url: input.url },
      cause,
    });
  }
  if (!response.ok) {
    throw new DomainError('PROVIDER_ERROR', {
      messageDe: `Der Anbieter hat den Download mit Status ${response.status} abgelehnt.`,
      details: { url: input.url, status: response.status },
    });
  }

  const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!contentType.startsWith('image/')) {
    throw new DomainError('PROVIDER_ERROR', {
      messageDe: 'Die Antwort des Anbieters ist kein Bild.',
      details: { url: input.url, contentType },
    });
  }

  const buffer = new Uint8Array(await response.arrayBuffer());
  const maxBytes = input.maxBytes ?? MAX_EXTERNAL_COPY_BYTES;
  if (buffer.byteLength === 0) {
    throw new DomainError('PROVIDER_ERROR', {
      messageDe: 'Der Anbieter hat eine leere Datei geliefert.',
      details: { url: input.url },
    });
  }
  if (buffer.byteLength > maxBytes) {
    throw new DomainError('PROVIDER_ERROR', {
      messageDe: 'Die Datei des Anbieters überschreitet das Größenlimit.',
      details: { url: input.url, byteLength: buffer.byteLength, maxBytes },
    });
  }

  return { bytes: buffer, contentType, sha256: await sha256Bytes(buffer) };
}

async function copyExternalVia(
  put: (input: PutSourceInput) => Promise<StoredObject>,
  input: CopyExternalInput,
): Promise<StoredObject> {
  const file = await fetchExternalImage(input);
  return put({
    sha256: file.sha256,
    bytes: file.bytes,
    contentType: file.contentType,
    path: sourcePath(file.sha256, file.contentType, input.namespace ?? 'external'),
    sourceUrl: input.url,
  });
}

/* -------------------------------------------------------------------------- */
/* In-memory implementation                                                    */
/* -------------------------------------------------------------------------- */

export interface MemoryEntry {
  object: StoredObject;
  bytes: Uint8Array;
}

/**
 * In-memory store for tests, demo mode and E2E.
 *
 * Its signed URLs use a `memory://` scheme on purpose. A URL that looked like a
 * real Supabase link would be a fabricated external — the one thing this
 * codebase never does.
 */
export class InMemoryCreativeStorage implements CreativeStorage {
  readonly bucket: string;
  private readonly entries = new Map<string, MemoryEntry>();

  constructor(bucket: string = DEFAULT_CREATIVE_BUCKET) {
    this.bucket = bucket;
  }

  async putSource(input: PutSourceInput): Promise<StoredObject> {
    const path = input.path ?? sourcePath(input.sha256, input.contentType);
    return this.write(path, input.bytes, input.contentType, input.sha256, input.sourceUrl ?? null);
  }

  async putRendition(input: PutRenditionInput): Promise<StoredObject> {
    const path = input.path ?? renditionPath(input.rendition, input.format);
    const sha256 = await sha256Bytes(input.bytes);
    return this.write(path, input.bytes, CONTENT_TYPES[input.format], sha256, null);
  }

  async getSignedUrl(path: string, expiresInSeconds = DEFAULT_SIGNED_URL_SECONDS): Promise<SignedUrl> {
    const entry = this.entries.get(path);
    if (!entry) {
      throw new DomainError('NOT_FOUND', {
        messageDe: 'Die Datei ist im Speicher nicht vorhanden.',
        details: { path },
      });
    }
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
    return {
      url: `memory://${this.bucket}/${path}?token=${entry.object.sha256.slice(0, 16)}`,
      expiresInSeconds,
      expiresAt,
    };
  }

  async copyExternal(input: CopyExternalInput): Promise<StoredObject> {
    return copyExternalVia((put) => this.putSource(put), input);
  }

  /* Test helpers. */

  read(path: string): Uint8Array | undefined {
    return this.entries.get(path)?.bytes;
  }

  get(path: string): StoredObject | undefined {
    return this.entries.get(path)?.object;
  }

  list(): StoredObject[] {
    return [...this.entries.values()].map((entry) => entry.object);
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  private write(
    path: string,
    bytes: Uint8Array,
    contentType: string,
    sha256: string,
    sourceUrl: string | null,
  ): StoredObject {
    const object: StoredObject = {
      bucket: this.bucket,
      path,
      contentType,
      byteLength: bytes.byteLength,
      sha256,
      createdAt: nowIso(),
      sourceUrl,
    };
    this.entries.set(path, { object, bytes: Uint8Array.from(bytes) });
    return object;
  }
}

/* -------------------------------------------------------------------------- */
/* Supabase-shaped implementation                                              */
/* -------------------------------------------------------------------------- */

export interface SupabaseUploadOptions {
  contentType?: string;
  upsert?: boolean;
  cacheControl?: string;
}

export interface SupabaseStorageResponse<T> {
  data: T | null;
  error: { message: string } | null;
}

/**
 * The slice of `@supabase/supabase-js` this package uses. Declaring it
 * structurally keeps the dependency direction clean: callers pass their client
 * in, and tests pass a fake.
 */
export interface SupabaseStorageBucketApi {
  upload(
    path: string,
    body: Uint8Array | ArrayBuffer | Blob,
    options?: SupabaseUploadOptions,
  ): Promise<SupabaseStorageResponse<{ path: string }>>;
  createSignedUrl(
    path: string,
    expiresIn: number,
  ): Promise<SupabaseStorageResponse<{ signedUrl: string }>>;
}

export interface SupabaseStorageClientLike {
  storage: { from(bucket: string): SupabaseStorageBucketApi };
}

export interface SupabaseCreativeStorageOptions {
  bucket?: string;
  cacheControl?: string;
  upsert?: boolean;
}

export function createSupabaseCreativeStorage(
  client: SupabaseStorageClientLike,
  options: SupabaseCreativeStorageOptions = {},
): CreativeStorage {
  const bucket = options.bucket ?? DEFAULT_CREATIVE_BUCKET;
  // Renditions are content-addressed by hash in their key, so they cache hard.
  const cacheControl = options.cacheControl ?? '31536000';
  const upsert = options.upsert ?? true;

  const upload = async (
    path: string,
    bytes: Uint8Array,
    contentType: string,
    sha256: string,
    sourceUrl: string | null,
  ): Promise<StoredObject> => {
    const result = await client.storage
      .from(bucket)
      .upload(path, bytes, { contentType, cacheControl, upsert });
    if (result.error) {
      throw new DomainError('PROVIDER_ERROR', {
        messageDe: 'Der Upload in den Storage-Bucket ist fehlgeschlagen.',
        details: { bucket, path, reason: result.error.message },
      });
    }
    return {
      bucket,
      path: result.data?.path ?? path,
      contentType,
      byteLength: bytes.byteLength,
      sha256,
      createdAt: nowIso(),
      sourceUrl,
    };
  };

  const storage: CreativeStorage = {
    async putSource(input) {
      const path = input.path ?? sourcePath(input.sha256, input.contentType);
      return upload(path, input.bytes, input.contentType, input.sha256, input.sourceUrl ?? null);
    },

    async putRendition(input) {
      const path = input.path ?? renditionPath(input.rendition, input.format);
      const sha256 = await sha256Bytes(input.bytes);
      return upload(path, input.bytes, CONTENT_TYPES[input.format], sha256, null);
    },

    async getSignedUrl(path, expiresInSeconds = DEFAULT_SIGNED_URL_SECONDS) {
      const result = await client.storage.from(bucket).createSignedUrl(path, expiresInSeconds);
      if (result.error || !result.data) {
        throw new DomainError('PROVIDER_ERROR', {
          messageDe: 'Es konnte keine signierte URL erzeugt werden.',
          details: { bucket, path, reason: result.error?.message ?? 'Keine Daten erhalten.' },
        });
      }
      return {
        url: result.data.signedUrl,
        expiresInSeconds,
        expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
      };
    },

    async copyExternal(input) {
      return copyExternalVia((put) => storage.putSource(put), input);
    },
  };

  return storage;
}

/* -------------------------------------------------------------------------- */
/* Convenience                                                                 */
/* -------------------------------------------------------------------------- */

export interface StoredRenditionSet {
  jpeg: StoredObject;
  webp: StoredObject;
}

/** Writes both encoded outputs of one rendition. */
export async function storeRenditionAssets(
  storage: CreativeStorage,
  rendition: CreativeRendition,
  assets: { jpeg: Uint8Array; webp: Uint8Array },
): Promise<StoredRenditionSet> {
  const [jpeg, webp] = await Promise.all([
    storage.putRendition({ rendition, format: 'jpeg', bytes: assets.jpeg }),
    storage.putRendition({ rendition, format: 'webp', bytes: assets.webp }),
  ]);
  return { jpeg, webp };
}
