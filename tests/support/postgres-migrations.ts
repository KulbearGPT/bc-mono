import { execFile as execFileCallback } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

export async function applyCurrentMigrations(input: {
  host: string;
  port: number;
  database: string;
  exclude?: string[];
  only?: string[];
}): Promise<void> {
  const migrations = (await readdir('database/prisma/migrations')).sort();
  const known = new Set(migrations);
  for (const requested of [...(input.exclude ?? []), ...(input.only ?? [])]) {
    if (!known.has(requested)) throw new Error(`Unknown PostgreSQL migration: ${requested}`);
  }
  const selected = migrations.filter((migration) =>
    input.only ? input.only.includes(migration) : !input.exclude?.includes(migration)
  );
  for (const migration of selected) {
    await execFile('psql', [
      '-h',
      input.host,
      '-p',
      String(input.port),
      '-d',
      input.database,
      '-v',
      'ON_ERROR_STOP=1',
      '-f',
      `database/prisma/migrations/${migration}/migration.sql`
    ]);
  }
}
