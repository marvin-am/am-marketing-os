import { describe, expect, it, vi } from 'vitest';
import { isDomainError } from '@am/domain';
import { sha256Bytes } from './compose';
import {
  DEFAULT_CREATIVE_BUCKET,
  InMemoryCreativeStorage,
  createSupabaseCreativeStorage,
  extensionForContentType,
  fetchExternalImage,
  renditionPath,
  sourcePath,
  storeRenditionAssets,
  type SupabaseStorageClientLike,
} from './storage';
import type { CreativeRendition } from './types';

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);

const RENDITION = {
  renditionKey: 'concept_1__bold-statement__1x1',
  conceptKey: 'concept_1',
} as Pick<CreativeRendition, 'renditionKey' | 'conceptKey'> as CreativeRendition;

function imageResponse(bytes: Uint8Array, contentType = 'image/jpeg'): Response {
  return new Response(new Blob([new Uint8Array(bytes)]), {
    status: 200,
    headers: { 'content-type': contentType },
  });
}

describe('path helpers', () => {
  it('maps content types to extensions', () => {
    expect(extensionForContentType('image/jpeg')).toBe('jpg');
    expect(extensionForContentType('image/webp; charset=binary')).toBe('webp');
    expect(extensionForContentType('application/pdf')).toBe('bin');
  });

  it('shards source paths by hash prefix', () => {
    const path = sourcePath('a'.repeat(64), 'image/png');
    expect(path).toBe(`sources/aa/${'a'.repeat(64)}.png`);
  });

  it('groups renditions by concept', () => {
    expect(renditionPath(RENDITION, 'jpeg')).toBe(
      'renditions/concept_1/concept_1__bold-statement__1x1.jpg',
    );
    expect(renditionPath(RENDITION, 'webp')).toBe(
      'renditions/concept_1/concept_1__bold-statement__1x1.webp',
    );
  });
});

describe('InMemoryCreativeStorage', () => {
  it('stores a source and returns a verifiable record', async () => {
    const storage = new InMemoryCreativeStorage();
    const hash = await sha256Bytes(PNG_BYTES);
    const stored = await storage.putSource({
      sha256: hash,
      bytes: PNG_BYTES,
      contentType: 'image/png',
    });

    expect(stored.bucket).toBe(DEFAULT_CREATIVE_BUCKET);
    expect(stored.byteLength).toBe(PNG_BYTES.byteLength);
    expect(stored.sha256).toBe(hash);
    expect(stored.sourceUrl).toBeNull();
    expect(storage.read(stored.path)).toEqual(PNG_BYTES);
  });

  it('copies the bytes so a later mutation cannot rewrite history', async () => {
    const storage = new InMemoryCreativeStorage();
    const mutable = Uint8Array.from(PNG_BYTES);
    const stored = await storage.putSource({
      sha256: await sha256Bytes(mutable),
      bytes: mutable,
      contentType: 'image/png',
    });
    mutable[0] = 0;
    expect(storage.read(stored.path)?.[0]).toBe(137);
  });

  it('stores both encoded outputs of a rendition', async () => {
    const storage = new InMemoryCreativeStorage();
    const set = await storeRenditionAssets(storage, RENDITION, {
      jpeg: PNG_BYTES,
      webp: PNG_BYTES,
    });
    expect(set.jpeg.contentType).toBe('image/jpeg');
    expect(set.webp.contentType).toBe('image/webp');
    expect(storage.size).toBe(2);
  });

  it('signs a URL that cannot be mistaken for a provider link', async () => {
    const storage = new InMemoryCreativeStorage();
    const stored = await storage.putSource({
      sha256: await sha256Bytes(PNG_BYTES),
      bytes: PNG_BYTES,
      contentType: 'image/png',
    });
    const signed = await storage.getSignedUrl(stored.path, 60);
    expect(signed.url.startsWith('memory://')).toBe(true);
    expect(signed.url).not.toContain('supabase');
    expect(signed.expiresInSeconds).toBe(60);
    expect(Date.parse(signed.expiresAt)).toBeGreaterThan(Date.now());
  });

  it('reports a missing file instead of inventing a URL', async () => {
    const storage = new InMemoryCreativeStorage();
    await expect(storage.getSignedUrl('sources/aa/missing.png')).rejects.toThrow(
      /nicht vorhanden/,
    );
  });
});

describe('copyExternal', () => {
  it('copies a provider file into our own bucket before its URL expires', async () => {
    const storage = new InMemoryCreativeStorage();
    const fetchImpl = vi.fn().mockResolvedValue(imageResponse(PNG_BYTES));
    const stored = await storage.copyExternal({
      url: 'https://scontent.example.com/creative-42.jpg?expires=soon',
      namespace: 'meta-historical',
      fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(stored.path.startsWith('meta-historical/')).toBe(true);
    expect(stored.sourceUrl).toBe('https://scontent.example.com/creative-42.jpg?expires=soon');
    expect(stored.sha256).toBe(await sha256Bytes(PNG_BYTES));
    expect(storage.read(stored.path)).toEqual(PNG_BYTES);
  });

  it('refuses a non-HTTPS URL', async () => {
    await expect(
      fetchExternalImage({
        url: 'http://example.com/x.jpg',
        fetchImpl: vi.fn() as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toThrow(/HTTPS/);
  });

  it('refuses a provider error rather than recording a broken copy', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 404 }));
    await expect(
      fetchExternalImage({
        url: 'https://example.com/x.jpg',
        fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toThrow(/Status 404/);
  });

  it('refuses a response that is not an image', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('<html/>', { headers: { 'content-type': 'text/html' } }));
    await expect(
      fetchExternalImage({
        url: 'https://example.com/x.jpg',
        fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toThrow(/kein Bild/);
  });

  it('enforces the size limit', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(imageResponse(new Uint8Array(2048)));
    await expect(
      fetchExternalImage({
        url: 'https://example.com/x.jpg',
        maxBytes: 1024,
        fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toThrow(/Größenlimit/);
  });

  it('surfaces a transport failure as a retryable domain error', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    await fetchExternalImage({
      url: 'https://example.com/x.jpg',
      fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
    }).catch((error: unknown) => {
      expect(isDomainError(error)).toBe(true);
      if (isDomainError(error)) {
        expect(error.code).toBe('PROVIDER_ERROR');
        expect(error.retryable).toBe(true);
      }
    });
    expect.assertions(3);
  });
});

describe('createSupabaseCreativeStorage', () => {
  function fakeClient(overrides: Partial<{ uploadError: string; signError: string }> = {}) {
    const uploads: Array<{ path: string; contentType?: string; byteLength: number }> = [];
    const client: SupabaseStorageClientLike = {
      storage: {
        from: (bucket: string) => ({
          upload: async (path, body, options) => {
            uploads.push({
              path,
              contentType: options?.contentType,
              byteLength: (body as Uint8Array).byteLength,
            });
            return overrides.uploadError
              ? { data: null, error: { message: overrides.uploadError } }
              : { data: { path }, error: null };
          },
          createSignedUrl: async (path, expiresIn) =>
            overrides.signError
              ? { data: null, error: { message: overrides.signError } }
              : {
                  data: { signedUrl: `https://project.example/storage/${bucket}/${path}?exp=${expiresIn}` },
                  error: null,
                },
        }),
      },
    };
    return { client, uploads };
  }

  it('uploads renditions with the right content type and path', async () => {
    const { client, uploads } = fakeClient();
    const storage = createSupabaseCreativeStorage(client, { bucket: 'am-creatives' });
    const stored = await storage.putRendition({
      rendition: RENDITION,
      format: 'webp',
      bytes: PNG_BYTES,
    });

    expect(stored.bucket).toBe('am-creatives');
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.path).toBe(renditionPath(RENDITION, 'webp'));
    expect(uploads[0]!.contentType).toBe('image/webp');
    expect(stored.sha256).toBe(await sha256Bytes(PNG_BYTES));
  });

  it('returns the provider’s signed URL unchanged', async () => {
    const { client } = fakeClient();
    const storage = createSupabaseCreativeStorage(client);
    const signed = await storage.getSignedUrl('renditions/a/b.jpg', 120);
    expect(signed.url).toContain('https://project.example/storage/creatives/renditions/a/b.jpg');
    expect(signed.expiresInSeconds).toBe(120);
  });

  it('turns an upload failure into a domain error, never a silent success', async () => {
    const { client } = fakeClient({ uploadError: 'bucket not found' });
    const storage = createSupabaseCreativeStorage(client);
    await expect(
      storage.putSource({
        sha256: await sha256Bytes(PNG_BYTES),
        bytes: PNG_BYTES,
        contentType: 'image/png',
      }),
    ).rejects.toThrow(/Upload/);
  });

  it('turns a signing failure into a domain error', async () => {
    const { client } = fakeClient({ signError: 'object not found' });
    const storage = createSupabaseCreativeStorage(client);
    await expect(storage.getSignedUrl('nope.jpg')).rejects.toThrow(/signierte URL/);
  });

  it('copies an external file through the injected client', async () => {
    const { client, uploads } = fakeClient();
    const storage = createSupabaseCreativeStorage(client);
    const fetchImpl = vi.fn().mockResolvedValue(imageResponse(PNG_BYTES, 'image/png'));
    const stored = await storage.copyExternal({
      url: 'https://scontent.example.com/old.png',
      fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
    });
    expect(uploads[0]!.path.startsWith('external/')).toBe(true);
    expect(stored.sourceUrl).toBe('https://scontent.example.com/old.png');
  });
});
