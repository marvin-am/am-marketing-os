#!/usr/bin/env node
/**
 * Loads `supabase/seed/*.sql` into DATABASE_URL.
 *
 * The seed is deterministic (fixed UUIDs, seeded PRNG) so tests can assert on
 * it. Running it twice is safe — every statement is written as an upsert.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEED_DIR = join(ROOT, 'supabase', 'seed');

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL ist nicht gesetzt. Beispiel:\n  DATABASE_URL="postgresql://..." pnpm db:seed');
  process.exit(1);
}

if (!existsSync(SEED_DIR)) {
  console.error(`Kein Seed-Verzeichnis unter ${SEED_DIR}.`);
  process.exit(1);
}

const files = readdirSync(SEED_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();

if (files.length === 0) {
  console.error(`Keine Seed-Dateien in ${SEED_DIR}.`);
  process.exit(1);
}

const pg = await import('pg');
const client = new pg.default.Client({ connectionString: databaseUrl });
await client.connect();

for (const filename of files) {
  process.stdout.write(`seeding ${filename} ... `);
  try {
    await client.query('BEGIN');
    await client.query(readFileSync(join(SEED_DIR, filename), 'utf8'));
    await client.query('COMMIT');
    console.log('ok');
  } catch (error) {
    await client.query('ROLLBACK');
    console.log('FEHLGESCHLAGEN');
    console.error(error.message);
    await client.end();
    process.exit(1);
  }
}

await client.end();
console.log('Seed abgeschlossen.');
