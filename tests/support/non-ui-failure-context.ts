const emitted = new Set<string>();
const databasePattern = /^blackcat_non_ui_[a-z0-9_]+_[0-9]+_[a-f0-9]{8}$/u;
const scenarioPattern = /^[A-Z0-9][A-Z0-9-]{2,63}$/u;

export interface NonUiFailureContext {
  database?: string;
  scenarioId?: string;
  sequence?: number;
}

export function formatNonUiFailureContext(input: NonUiFailureContext): string {
  const fields: string[] = [];
  if (input.database !== undefined) {
    if (!databasePattern.test(input.database)) throw new Error(`Unsafe failure-context database: ${input.database}`);
    fields.push(`database=${input.database}`);
  }
  if (input.scenarioId !== undefined || input.sequence !== undefined) {
    if (!input.scenarioId || !scenarioPattern.test(input.scenarioId)) {
      throw new Error(`Unsafe failure-context scenario: ${input.scenarioId ?? ''}`);
    }
    if (!Number.isSafeInteger(input.sequence) || Number(input.sequence) < 0) {
      throw new Error(`Unsafe failure-context sequence: ${String(input.sequence)}`);
    }
    const namespace = `${input.scenarioId}:${input.sequence}`;
    fields.push(
      `scenario=${input.scenarioId}`,
      `guildFixtureId=${namespace}:guild-set`,
      `actorFixtureId=${namespace}:actor-set`
    );
  }
  if (fields.length === 0) throw new Error('Failure context requires a database or scenario fixture.');
  return `[NON_UI_CONTEXT] ${fields.join(' ')}`;
}

export function emitNonUiFailureContext(input: NonUiFailureContext): void {
  if (process.env.NON_UI_EMIT_FAILURE_CONTEXT !== '1') return;
  const line = formatNonUiFailureContext(input);
  if (emitted.has(line)) return;
  emitted.add(line);
  process.stderr.write(`${line}\n`);
}
