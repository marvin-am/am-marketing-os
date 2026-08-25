#!/usr/bin/env node
/**
 * Applies `supabase/migrations/*.sql` in filename order against DATABASE_URL.
 *
 * Deliberately a plain script rather than a migration framework: the SQL files
 * are the source of truth, ordering is lexicographic, and every applied file is
 * recorded in `_am_migrations` so re-runs are no-ops.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = join(ROOT, 'supabase', 'migrations');

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error(
    'DATABASE_URL ist nicht gesetzt.\n' +
      'Setzen Sie die Verbindung zu Ihrer Supabase-Instanz und starten Sie erneut:\n' +
      '  DATABASE_URL="postgresql://..." pnpm db:migrate',
  );
  process.exit(1);
}

let pg;
try {
  pg = await import('pg');
} catch {
  console.error('Das Paket "pg" fehlt. Installieren Sie es mit: pnpm add -Dw pg');
  process.exit(1);
}

const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();

if (files.length === 0) {
  console.error(`Keine Migrationen in ${MIGRATIONS_DIR} gefunden.`);
  process.exit(1);
}

const client = new pg.default.Client({ connectionString: databaseUrl });
await client.connect();

await client.query(`
  CREATE TABLE IF NOT EXISTS _am_migrations (
    filename    text PRIMARY KEY,
    checksum    text NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now()
  );
`);

const { rows: applied } = await client.query('SELECT filename, checksum FROM _am_migrations');
const appliedMap = new Map(applied.map((r) => [r.filename, r.checksum]));

let appliedCount = 0;
for (const filename of files) {
  const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');
  const checksum = createHash('sha256').update(sql).digest('hex');
  const previous = appliedMap.get(filename);

  if (previous) {
    if (previous !== checksum) {
      console.error(
        `Migration ${filename} wurde nach dem Anwenden verändert.\n` +
          'Migrationen sind unveränderlich — legen Sie stattdessen eine neue Datei an.',
      );
      await client.end();
      process.exit(1);
    }
    continue;
  }

  process.stdout.write(`applying ${filename} ... `);
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO _am_migrations (filename, checksum) VALUES ($1, $2)', [
      filename,
      checksum,
    ]);
    await client.query('COMMIT');
    console.log('ok');
    appliedCount += 1;
  } catch (error) {
    await client.query('ROLLBACK');
    console.log('FEHLGESCHLAGEN');
    console.error(error.message);
    await client.end();
    process.exit(1);
  }
}

await client.end();
console.log(
  appliedCount === 0
    ? 'Datenbank ist aktuell — keine neuen Migrationen.'
    : `${appliedCount} Migration(en) angewendet.`,
);
