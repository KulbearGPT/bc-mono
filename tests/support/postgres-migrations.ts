import { execFile as execFileCallback } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

export async function applyCurrentMigrations(input: { host: string; port: number; database: string }): Promise<void> {
  const migrations = (await readdir('database/prisma/migrations')).sort();
  for (const migration of migrations) {
    await execFile('psql', ['-h', input.host, '-p', String(input.port), '-d', input.database,
      '-v', 'ON_ERROR_STOP=1', '-f', `database/prisma/migrations/${migration}/migration.sql`]);
  }
}
