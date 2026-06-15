/**
 * Runner de migrações SQL.
 *
 * Executa todos os arquivos .sql de infra/migrations/ em ordem alfabética.
 * Usa uma tabela `schema_migrations` no banco para rastrear quais já foram aplicadas.
 *
 * Uso:
 *   npx tsx scripts/migrate.ts
 *   DATABASE_URL=postgres://... npx tsx scripts/migrate.ts
 */

import { readdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import dotenv from 'dotenv';

const currentDir = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(currentDir, '..', '..', '..', '..');
dotenv.config({ path: join(repoRoot, '.env') });

const MIGRATIONS_DIR = resolve(currentDir, '..', '..', '..', 'infra', 'migrations');
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL não definida');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL });

async function ensureMigrationsTable(client: pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function appliedMigrations(client: pg.PoolClient): Promise<Set<string>> {
  const { rows } = await client.query<{ filename: string }>('SELECT filename FROM schema_migrations');
  return new Set(rows.map((r) => r.filename));
}

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const applied = await appliedMigrations(client);

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    let ran = 0;
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`  ✓ ${file} (já aplicada)`);
        continue;
      }

      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      console.log(`  ⏳ Aplicando ${file}…`);

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`  ✅ ${file}`);
        ran++;
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`  ❌ Erro em ${file}:`, err instanceof Error ? err.message : err);
        process.exit(1);
      }
    }

    if (ran === 0) {
      console.log('\nNenhuma migração nova para aplicar.');
    } else {
      console.log(`\n${ran} migração(ões) aplicada(s) com sucesso.`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

console.log('🔄 Iniciando runner de migrações…\n');
await run();
