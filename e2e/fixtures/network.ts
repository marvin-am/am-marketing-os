import { expect, type Page } from '@playwright/test';

/**
 * What the funnel runtime actually answered.
 *
 * The store is inside the server process and the suite has no back door into
 * it, so "exactly one submission exists" is asserted from the endpoint's own
 * contract instead: `submitLead` returns the accepted `submissionId` and
 * `duplicate: false` for the attempt that created it, and the *same*
 * `submissionId` with `duplicate: true` for every replay of that attempt id.
 * Ten responses carrying one id and one `duplicate: false` is the idempotency
 * guarantee, observed from outside.
 */

export interface SubmitResponseBody {
  ok: boolean;
  code?: string;
  messageDe?: string;
  submissionId?: string;
  duplicate?: boolean;
  outcome?: string;
  resultVariantId?: string | null;
  capiQueued?: boolean;
  capiConfigured?: boolean;
  fieldErrors?: { fieldId: string; code: string; messageDe: string }[];
}

export interface SubmitRecord {
  status: number;
  body: SubmitResponseBody | null;
}

export class SubmitRecorder {
  private readonly pending: Promise<void>[] = [];
  private readonly records: SubmitRecord[] = [];

  constructor(page: Page, endpoint = '/api/submit') {
    page.on('response', (response) => {
      if (!response.url().includes(endpoint)) return;
      this.pending.push(
        (async () => {
          const status = response.status();
          let body: SubmitResponseBody | null = null;
          try {
            body = (await response.json()) as SubmitResponseBody;
          } catch {
            body = null;
          }
          this.records.push({ status, body });
        })(),
      );
    });
  }

  /** Every response seen so far, once each has been read to completion. */
  async settled(): Promise<SubmitRecord[]> {
    await Promise.all(this.pending);
    return [...this.records];
  }

  /** Waits until exactly `count` submit responses have come back. */
  async waitForResponses(count: number): Promise<SubmitRecord[]> {
    await expect
      .poll(async () => (await this.settled()).length, {
        message: `Es wurden ${count} Antworten von /api/submit erwartet.`,
        timeout: 20_000,
      })
      .toBe(count);
    return this.settled();
  }

  /**
   * Asserts the whole batch collapsed onto one submission and returns its id.
   */
  async expectExactlyOneSubmission(attempts: number): Promise<string> {
    const records = await this.waitForResponses(attempts);
    const accepted = records.filter((record) => record.body?.ok === true);
    expect(
      accepted.length,
      `Nicht jede Übermittlung wurde angenommen: ${JSON.stringify(records)}`,
    ).toBe(attempts);

    const created = accepted.filter((record) => record.body?.duplicate === false);
    expect(
      created.length,
      `Es darf genau eine Submission entstehen, entstanden sind ${created.length}.`,
    ).toBe(1);

    const ids = new Set(accepted.map((record) => record.body?.submissionId));
    expect(ids.size, `Mehrere Submission-Ids für einen Versuch: ${[...ids].join(', ')}`).toBe(1);

    const submissionId = [...ids][0];
    if (!submissionId) throw new Error('Die Antwort trug keine Submission-Id.');
    return submissionId;
  }
}
