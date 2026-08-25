import {
  DomainError,
  canWriteHubspot,
  dryRun,
  nowIso,
  type DryRunResult,
  type FeatureFlags,
  type IsoTimestamp,
} from '@am/domain';
import { instrumented, sleep } from '@am/observability';
import type { PropertyBag } from './types';
import {
  performed,
  type AssociationReadResult,
  type AssociationRecord,
  type BatchReadAssociationsInput,
  type BatchReadInput,
  type ChangeCursor,
  type CreateAssociationInput,
  type CreateDealInput,
  type HubspotObjectRecord,
  type ObjectTypeDefinition,
  type PipelineDefinition,
  type PropertyDefinition,
  type ProviderConnectionProbe,
  type RecentChangePage,
  type SearchContactInput,
  type UpdateObjectInput,
  type UpsertObjectInput,
  type WriteOutcome,
} from './provider-types';

/**
 * The live HubSpot adapter.
 *
 * Everything that is allowed to touch the network lives here. Writes are gated
 * by `canWriteHubspot()` and return a `DryRunResult` when the flags are off, so
 * the code path exercised in dry-run mode is exactly the one that would run for
 * real — only the final request is withheld.
 */

const DEFAULT_BASE_URL = 'https://api.hubapi.com';
const DEFAULT_MAX_RETRIES = 4;
const MAX_SINGLE_BACKOFF_MS = 60_000;
const PAGE_LIMIT = 100;
const MAX_PAGES = 200;

export interface LiveProviderOptions {
  /** Private app token or OAuth access token. */
  token: string;
  flags: FeatureFlags;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  maxRetries?: number;
  clock?: () => IsoTimestamp;
}

interface HubspotApiObject {
  id: string;
  properties?: Record<string, string | null>;
  createdAt?: string;
  updatedAt?: string;
  archived?: boolean;
}

interface HubspotPagedResponse<T> {
  results?: T[];
  paging?: { next?: { after?: string } };
  total?: number;
}

interface RequestOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** 404 resolves to `null` instead of raising. */
  allowNotFound?: boolean;
}

/** HubSpot returns `Retry-After` in seconds on the API and in ms in some docs. */
export function parseRetryAfterMs(raw: string | null): number | null {
  if (!raw) return null;
  const numeric = Number(raw.trim());
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return numeric <= 300 ? numeric * 1000 : numeric;
}

function toRecord(objectType: string, raw: HubspotApiObject): HubspotObjectRecord {
  const properties: PropertyBag = {};
  for (const [key, value] of Object.entries(raw.properties ?? {})) {
    properties[key] = value === undefined ? null : value;
  }
  return {
    id: String(raw.id),
    objectType,
    properties,
    createdAt: raw.createdAt ?? nowIso(),
    updatedAt: raw.updatedAt ?? raw.createdAt ?? nowIso(),
    archived: raw.archived === true,
  };
}

function messageFrom(payload: unknown): string | null {
  if (typeof payload === 'object' && payload !== null && 'message' in payload) {
    const value = (payload as { message?: unknown }).message;
    if (typeof value === 'string') return value.slice(0, 400);
  }
  return null;
}

/** Maps a HubSpot HTTP failure onto the domain error taxonomy. */
export function mapHubspotError(
  status: number,
  payload: unknown,
  operation: string,
  retryAfterMs: number | null = null,
): DomainError {
  const detail = messageFrom(payload);
  const details = { operation, status, providerMessage: detail, retryAfterMs };

  if (status === 401) {
    return new DomainError('PROVIDER_NOT_CONFIGURED', {
      messageDe: 'Das HubSpot-Token ist ungültig oder abgelaufen.',
      details,
    });
  }
  if (status === 403) {
    return new DomainError('FORBIDDEN', {
      messageDe: 'Dem HubSpot-Token fehlt eine erforderliche Berechtigung (Scope).',
      details,
    });
  }
  if (status === 404) {
    return new DomainError('NOT_FOUND', {
      messageDe: 'Der HubSpot-Datensatz wurde nicht gefunden.',
      details,
    });
  }
  if (status === 409) {
    return new DomainError('CONFLICT', {
      messageDe: 'HubSpot meldet einen Konflikt — der Datensatz existiert bereits.',
      details,
    });
  }
  if (status === 429) {
    return new DomainError('PROVIDER_RATE_LIMITED', {
      messageDe: 'HubSpot hat das Anfragelimit begrenzt. Die Synchronisation wird wiederholt.',
      details,
      retryable: true,
    });
  }
  if (status === 400 || status === 422) {
    return new DomainError('VALIDATION_FAILED', {
      messageDe: `HubSpot hat die Anfrage abgelehnt: ${detail ?? 'ungültige Daten'}.`,
      details,
    });
  }
  return new DomainError('PROVIDER_ERROR', {
    messageDe: 'HubSpot hat einen Fehler zurückgegeben.',
    details,
    retryable: status >= 500 || status === 0,
  });
}

export class LiveHubspotProvider {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly flags: FeatureFlags;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly clock: () => IsoTimestamp;

  constructor(options: LiveProviderOptions) {
    this.token = options.token;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.flags = options.flags;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleepImpl = options.sleepImpl ?? sleep;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.clock = options.clock ?? nowIso;
  }

  /* ---------------------------------------------------------------------- */
  /* HTTP plumbing                                                           */
  /* ---------------------------------------------------------------------- */

  private url(path: string, query?: RequestOptions['query']): string {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private async request<T>(operation: string, options: RequestOptions): Promise<T | null> {
    let attempt = 0;

    for (;;) {
      attempt += 1;
      let response: Response;
      try {
        response = await this.fetchImpl(this.url(options.path, options.query), {
          method: options.method,
          headers: {
            authorization: `Bearer ${this.token}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
        });
      } catch (cause) {
        const error = new DomainError('PROVIDER_ERROR', {
          messageDe: 'HubSpot ist derzeit nicht erreichbar.',
          details: { operation, attempt },
          cause,
          retryable: true,
        });
        if (attempt > this.maxRetries) throw error;
        await this.sleepImpl(backoffMs(attempt));
        continue;
      }

      if (response.status === 204) return null;

      const text = await response.text();
      const payload: unknown = text.length > 0 ? safeJson(text) : null;

      if (response.ok) return payload as T;

      if (response.status === 404 && options.allowNotFound) return null;

      const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
      const error = mapHubspotError(response.status, payload, operation, retryAfterMs);

      const retryable = error.retryable && attempt <= this.maxRetries;
      if (!retryable) throw error;

      const waitMs = Math.min(retryAfterMs ?? backoffMs(attempt), MAX_SINGLE_BACKOFF_MS);
      await this.sleepImpl(waitMs);
    }
  }

  private async paginate<TRaw>(
    operation: string,
    path: string,
    query: RequestOptions['query'] = {},
  ): Promise<TRaw[]> {
    const collected: TRaw[] = [];
    let after: string | undefined;
    let page = 0;

    do {
      page += 1;
      const response = await this.request<HubspotPagedResponse<TRaw>>(operation, {
        method: 'GET',
        path,
        query: { ...query, limit: PAGE_LIMIT, after },
      });
      collected.push(...(response?.results ?? []));
      after = response?.paging?.next?.after;
    } while (after && page < MAX_PAGES);

    return collected;
  }

  private blocked(operation: string, wouldSend: Record<string, unknown>): DryRunResult {
    return dryRun(
      'HUBSPOT',
      operation,
      wouldSend,
      'HubSpot-Schreibzugriffe sind deaktiviert (EXTERNAL_WRITES_ENABLED / HUBSPOT_WRITES_ENABLED = false).',
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Reads                                                                   */
  /* ---------------------------------------------------------------------- */

  async health(): Promise<ProviderConnectionProbe> {
    return instrumented('HUBSPOT', 'hubspot.health', async () => {
      const checkedAt = this.clock();
      if (!this.token) {
        return {
          reachable: false,
          state: 'NOT_CONFIGURED' as const,
          grantedScopes: [],
          accountLabel: null,
          portalId: null,
          detailDe: 'Es ist kein HubSpot-Token hinterlegt.',
          checkedAt,
        };
      }

      try {
        await this.request<HubspotPagedResponse<PropertyDefinition>>('hubspot.health.probe', {
          method: 'GET',
          path: '/crm/v3/properties/contacts',
          query: { limit: 1 },
        });
      } catch (error) {
        const domainError = error instanceof DomainError ? error : null;
        return {
          reachable: false,
          state: domainError?.code === 'PROVIDER_NOT_CONFIGURED' ? 'NOT_CONFIGURED' : 'ERROR',
          grantedScopes: [],
          accountLabel: null,
          portalId: null,
          detailDe: domainError?.messageDe ?? 'HubSpot ist derzeit nicht erreichbar.',
          checkedAt,
        };
      }

      // Scope introspection only works for OAuth access tokens; a private app
      // token has no introspection endpoint. We never guess the scope list.
      let grantedScopes: string[] = [];
      let portalId: string | null = null;
      let accountLabel: string | null = null;
      let detailDe: string | null = null;
      try {
        const info = await this.request<{
          hubId?: number;
          scopes?: string[];
          user?: string;
        }>('hubspot.health.token', {
          method: 'GET',
          path: `/oauth/v1/access-tokens/${encodeURIComponent(this.token)}`,
          allowNotFound: true,
        });
        grantedScopes = info?.scopes ?? [];
        portalId = info?.hubId !== undefined ? String(info.hubId) : null;
        accountLabel = info?.user ?? null;
        if (grantedScopes.length === 0) {
          detailDe = 'Verbindung besteht; die Scope-Liste ist für dieses Token nicht auslesbar.';
        }
      } catch {
        detailDe = 'Verbindung besteht; die Scope-Liste ist für dieses Token nicht auslesbar.';
      }

      return {
        reachable: true,
        state: 'CONNECTED' as const,
        grantedScopes,
        accountLabel,
        portalId,
        detailDe,
        checkedAt,
      };
    });
  }

  async listObjectTypes(): Promise<ObjectTypeDefinition[]> {
    return instrumented('HUBSPOT', 'hubspot.listObjectTypes', async () => {
      const response = await this.request<
        HubspotPagedResponse<{
          name?: string;
          objectTypeId?: string;
          labels?: { singular?: string; plural?: string };
          fullyQualifiedName?: string;
        }>
      >('hubspot.listObjectTypes', {
        method: 'GET',
        path: '/crm/v3/schemas',
        query: { includeStandard: true },
      });

      return (response?.results ?? []).map((schema) => ({
        objectType: schema.name ?? schema.objectTypeId ?? '',
        singularLabel: schema.labels?.singular ?? schema.name ?? '',
        pluralLabel: schema.labels?.plural ?? schema.name ?? '',
        custom: (schema.fullyQualifiedName ?? '').startsWith('p'),
      }));
    });
  }

  async listProperties(objectType: string): Promise<PropertyDefinition[]> {
    return instrumented('HUBSPOT', 'hubspot.listProperties', async () => {
      const raw = await this.paginate<{
        name?: string;
        label?: string;
        type?: string;
        fieldType?: string;
        groupName?: string;
        options?: { label?: string; value?: string }[];
        hasUniqueValue?: boolean;
        calculated?: boolean;
        archived?: boolean;
      }>('hubspot.listProperties', `/crm/v3/properties/${encodeURIComponent(objectType)}`);

      return raw.map((p) => ({
        name: p.name ?? '',
        label: p.label ?? p.name ?? '',
        type: p.type ?? 'string',
        fieldType: p.fieldType ?? 'text',
        groupName: p.groupName ?? null,
        options: (p.options ?? []).map((o) => ({ label: o.label ?? '', value: o.value ?? '' })),
        hasUniqueValue: p.hasUniqueValue === true,
        calculated: p.calculated === true,
        archived: p.archived === true,
      }));
    });
  }

  async listPipelines(objectType = 'deals'): Promise<PipelineDefinition[]> {
    return instrumented('HUBSPOT', 'hubspot.listPipelines', async () => {
      const response = await this.request<
        HubspotPagedResponse<{
          id?: string;
          label?: string;
          displayOrder?: number;
          stages?: {
            id?: string;
            label?: string;
            displayOrder?: number;
            metadata?: { isClosed?: string | boolean; probability?: string | number };
          }[];
        }>
      >('hubspot.listPipelines', {
        method: 'GET',
        path: `/crm/v3/pipelines/${encodeURIComponent(objectType)}`,
      });

      return (response?.results ?? []).map((pipeline) => ({
        id: pipeline.id ?? '',
        label: pipeline.label ?? '',
        objectType,
        displayOrder: pipeline.displayOrder ?? 0,
        stages: (pipeline.stages ?? []).map((stage) => ({
          id: stage.id ?? '',
          label: stage.label ?? '',
          displayOrder: stage.displayOrder ?? 0,
          isClosed: stage.metadata?.isClosed === true || stage.metadata?.isClosed === 'true',
          probability:
            stage.metadata?.probability === undefined
              ? null
              : Number(stage.metadata.probability) || 0,
        })),
      }));
    });
  }

  async batchReadObjects(input: BatchReadInput): Promise<HubspotObjectRecord[]> {
    if (input.ids.length === 0) return [];
    return instrumented('HUBSPOT', 'hubspot.batchReadObjects', async () => {
      const results: HubspotObjectRecord[] = [];
      for (let offset = 0; offset < input.ids.length; offset += PAGE_LIMIT) {
        const chunk = input.ids.slice(offset, offset + PAGE_LIMIT);
        const response = await this.request<HubspotPagedResponse<HubspotApiObject>>(
          'hubspot.batchReadObjects',
          {
            method: 'POST',
            path: `/crm/v3/objects/${encodeURIComponent(input.objectType)}/batch/read`,
            body: {
              properties: [...input.properties],
              idProperty: input.idProperty ?? undefined,
              inputs: chunk.map((id) => ({ id })),
            },
          },
        );
        results.push(...(response?.results ?? []).map((raw) => toRecord(input.objectType, raw)));
      }
      return results;
    });
  }

  async searchContactByEmail(input: SearchContactInput): Promise<HubspotObjectRecord | null> {
    return instrumented('HUBSPOT', 'hubspot.searchContactByEmail', async () => {
      const response = await this.request<HubspotPagedResponse<HubspotApiObject>>(
        'hubspot.searchContactByEmail',
        {
          method: 'POST',
          path: `/crm/v3/objects/${encodeURIComponent(input.objectType)}/search`,
          body: {
            filterGroups: [
              {
                filters: [
                  {
                    propertyName: input.identifierProperty,
                    operator: 'EQ',
                    value: input.identifierValue,
                  },
                ],
              },
            ],
            properties: [...input.properties],
            limit: 1,
          },
        },
      );
      const first = response?.results?.[0];
      return first ? toRecord(input.objectType, first) : null;
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Writes                                                                  */
  /* ---------------------------------------------------------------------- */

  private async upsertObject(
    operation: string,
    input: UpsertObjectInput,
  ): Promise<WriteOutcome<HubspotObjectRecord>> {
    if (!canWriteHubspot(this.flags)) {
      return this.blocked(operation, {
        objectType: input.objectType,
        objectId: input.objectId ?? null,
        idProperty: input.idProperty ?? null,
        idValue: input.idValue ?? null,
        properties: input.properties,
        idempotencyKey: input.idempotencyKey,
      });
    }

    return instrumented('HUBSPOT', operation, async () => {
      let objectId = input.objectId ?? null;

      if (!objectId && input.idProperty && input.idValue) {
        const existing = await this.searchContactByEmail({
          objectType: input.objectType,
          identifierProperty: input.idProperty,
          identifierValue: input.idValue,
          properties: Object.keys(input.properties),
        });
        objectId = existing?.id ?? null;
      }

      const raw = objectId
        ? await this.request<HubspotApiObject>(operation, {
            method: 'PATCH',
            path: `/crm/v3/objects/${encodeURIComponent(input.objectType)}/${encodeURIComponent(objectId)}`,
            body: { properties: input.properties },
          })
        : await this.request<HubspotApiObject>(operation, {
            method: 'POST',
            path: `/crm/v3/objects/${encodeURIComponent(input.objectType)}`,
            body: { properties: input.properties },
          });

      if (!raw) {
        throw new DomainError('PROVIDER_ERROR', {
          messageDe: 'HubSpot hat keine Antwort auf den Schreibvorgang zurückgegeben.',
          details: { operation },
        });
      }
      return performed(toRecord(input.objectType, raw));
    });
  }

  async upsertContact(input: UpsertObjectInput): Promise<WriteOutcome<HubspotObjectRecord>> {
    return this.upsertObject('hubspot.upsertContact', input);
  }

  async upsertCompany(input: UpsertObjectInput): Promise<WriteOutcome<HubspotObjectRecord>> {
    return this.upsertObject('hubspot.upsertCompany', input);
  }

  async createDeal(input: CreateDealInput): Promise<WriteOutcome<HubspotObjectRecord>> {
    const operation = 'hubspot.createDeal';
    if (!canWriteHubspot(this.flags)) {
      return this.blocked(operation, {
        objectType: input.objectType,
        properties: input.properties,
        idempotencyKey: input.idempotencyKey,
      });
    }
    return instrumented('HUBSPOT', operation, async () => {
      const raw = await this.request<HubspotApiObject>(operation, {
        method: 'POST',
        path: `/crm/v3/objects/${encodeURIComponent(input.objectType)}`,
        body: { properties: input.properties },
      });
      if (!raw) {
        throw new DomainError('PROVIDER_ERROR', {
          messageDe: 'HubSpot hat keine Antwort auf die Deal-Erstellung zurückgegeben.',
          details: { operation },
        });
      }
      return performed(toRecord(input.objectType, raw));
    });
  }

  async updateDeal(input: UpdateObjectInput): Promise<WriteOutcome<HubspotObjectRecord>> {
    const operation = 'hubspot.updateDeal';
    if (!canWriteHubspot(this.flags)) {
      return this.blocked(operation, {
        objectType: input.objectType,
        objectId: input.objectId,
        properties: input.properties,
        idempotencyKey: input.idempotencyKey,
      });
    }
    return instrumented('HUBSPOT', operation, async () => {
      const raw = await this.request<HubspotApiObject>(operation, {
        method: 'PATCH',
        path: `/crm/v3/objects/${encodeURIComponent(input.objectType)}/${encodeURIComponent(input.objectId)}`,
        body: { properties: input.properties },
      });
      if (!raw) {
        throw new DomainError('PROVIDER_ERROR', {
          messageDe: 'HubSpot hat keine Antwort auf die Deal-Aktualisierung zurückgegeben.',
          details: { operation },
        });
      }
      return performed(toRecord(input.objectType, raw));
    });
  }

  async createAssociation(
    input: CreateAssociationInput,
  ): Promise<WriteOutcome<AssociationRecord>> {
    const operation = 'hubspot.createAssociation';
    if (!canWriteHubspot(this.flags)) {
      return this.blocked(operation, {
        fromObjectType: input.fromObjectType,
        fromObjectId: input.fromObjectId,
        toObjectType: input.toObjectType,
        toObjectId: input.toObjectId,
        associationCategory: input.associationCategory,
        associationTypeId: input.associationTypeId,
        idempotencyKey: input.idempotencyKey,
      });
    }

    return instrumented('HUBSPOT', operation, async () => {
      const from = encodeURIComponent(input.fromObjectType);
      const fromId = encodeURIComponent(input.fromObjectId);
      const to = encodeURIComponent(input.toObjectType);
      const toId = encodeURIComponent(input.toObjectId);

      if (input.associationTypeId === null) {
        // Default label for the pair — HubSpot picks the correct directional id.
        await this.request<unknown>(operation, {
          method: 'PUT',
          path: `/crm/v4/objects/${from}/${fromId}/associations/default/${to}/${toId}`,
        });
      } else {
        await this.request<unknown>(operation, {
          method: 'PUT',
          path: `/crm/v4/objects/${from}/${fromId}/associations/${to}/${toId}`,
          body: [
            {
              associationCategory: input.associationCategory,
              associationTypeId: input.associationTypeId,
            },
          ],
        });
      }

      return performed({
        fromObjectType: input.fromObjectType,
        fromObjectId: input.fromObjectId,
        toObjectType: input.toObjectType,
        toObjectId: input.toObjectId,
        associationCategory: input.associationCategory,
        associationTypeId: input.associationTypeId,
      });
    });
  }

  async batchReadAssociations(
    input: BatchReadAssociationsInput,
  ): Promise<AssociationReadResult[]> {
    if (input.fromObjectIds.length === 0) return [];
    return instrumented('HUBSPOT', 'hubspot.batchReadAssociations', async () => {
      const results: AssociationReadResult[] = [];
      for (let offset = 0; offset < input.fromObjectIds.length; offset += PAGE_LIMIT) {
        const chunk = input.fromObjectIds.slice(offset, offset + PAGE_LIMIT);
        const response = await this.request<
          HubspotPagedResponse<{ from?: { id?: string }; to?: { toObjectId?: string | number }[] }>
        >('hubspot.batchReadAssociations', {
          method: 'POST',
          path: `/crm/v4/associations/${encodeURIComponent(input.fromObjectType)}/${encodeURIComponent(input.toObjectType)}/batch/read`,
          body: { inputs: chunk.map((id) => ({ id })) },
        });

        for (const entry of response?.results ?? []) {
          results.push({
            fromObjectId: String(entry.from?.id ?? ''),
            toObjectIds: (entry.to ?? [])
              .map((t) => (t.toObjectId === undefined ? '' : String(t.toObjectId)))
              .filter((id) => id.length > 0),
          });
        }
      }
      return results;
    });
  }

  async listRecentChanges(cursor: ChangeCursor | null): Promise<RecentChangePage> {
    const objectType = cursor?.objectType ?? 'deals';
    const since = cursor?.since ?? new Date(Date.now() - 60 * 60 * 1000).toISOString();

    return instrumented('HUBSPOT', 'hubspot.listRecentChanges', async () => {
      const response = await this.request<HubspotPagedResponse<HubspotApiObject>>(
        'hubspot.listRecentChanges',
        {
          method: 'POST',
          path: `/crm/v3/objects/${encodeURIComponent(objectType)}/search`,
          body: {
            filterGroups: [
              {
                filters: [
                  {
                    propertyName: 'hs_lastmodifieddate',
                    operator: 'GTE',
                    value: String(new Date(since).getTime()),
                  },
                ],
              },
            ],
            sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'ASCENDING' }],
            properties: ['hs_lastmodifieddate'],
            limit: PAGE_LIMIT,
            after: cursor?.after ?? undefined,
          },
        },
      );

      const results = response?.results ?? [];
      const changes = results.map((raw) => ({
        objectType,
        objectId: String(raw.id),
        occurredAt:
          normalizeTimestamp(raw.properties?.hs_lastmodifieddate ?? raw.updatedAt ?? null) ??
          this.clock(),
        changedProperties: [] as string[],
      }));

      const after = response?.paging?.next?.after ?? null;
      const latest = changes.length > 0 ? changes[changes.length - 1].occurredAt : since;

      return {
        changes,
        nextCursor: { since: latest, after, objectType },
        hasMore: after !== null,
      };
    });
  }
}

/** HubSpot returns timestamps as ISO-8601 or as epoch milliseconds. */
function normalizeTimestamp(raw: string | null): IsoTimestamp | null {
  if (!raw) return null;
  const ms = /^\d{10,16}$/.test(raw) ? Number(raw) : Date.parse(raw);
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function backoffMs(attempt: number): number {
  return Math.min(MAX_SINGLE_BACKOFF_MS, 500 * 2 ** Math.max(0, attempt - 1));
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 400) };
  }
}
