/**
 * A v4 UUID in the browser, with graceful degradation.
 *
 * `crypto.randomUUID` is only exposed in secure contexts; a funnel served over
 * plain HTTP in local development would otherwise throw while generating the
 * idempotency key, which is the one value a submit must never be missing.
 */
export function randomId(): string {
  const cryptoRef = globalThis.crypto as Crypto | undefined;
  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') return cryptoRef.randomUUID();

  const bytes = new Uint8Array(16);
  if (cryptoRef && typeof cryptoRef.getRandomValues === 'function') {
    cryptoRef.getRandomValues(bytes);
  } else {
    for (let index = 0; index < 16; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;

  const hex: string[] = [];
  for (let index = 0; index < 16; index += 1) {
    hex.push((bytes[index] as number).toString(16).padStart(2, '0'));
  }
  const joined = hex.join('');
  return [
    joined.slice(0, 8),
    joined.slice(8, 12),
    joined.slice(12, 16),
    joined.slice(16, 20),
    joined.slice(20),
  ].join('-');
}
