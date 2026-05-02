export type RuntimeEnvInput = Record<string, string | undefined>;

export type RuntimeEnvErrorCode = 'REQUIRED' | 'INVALID_PORT' | 'INVALID_URL';

export interface RuntimeEnvError {
  field: string;
  code: RuntimeEnvErrorCode;
  message: string;
}

export interface RuntimeEnvValidation {
  ok: boolean;
  errors: RuntimeEnvError[];
  values: {
    nodeEnv: 'development' | 'test' | 'production';
    apiPort: number;
    apiBaseUrl: string;
    databaseUrl: string;
    botServiceToken: string;
    discordBotToken?: string;
  };
}

export interface RuntimeEnvOptions {
  allowMissingDiscordToken?: boolean;
}

const DEFAULT_API_PORT = 3000;

export function validateRuntimeEnv(
  env: RuntimeEnvInput,
  options: RuntimeEnvOptions = {}
): RuntimeEnvValidation {
  const nodeEnv = normalizeNodeEnv(env.NODE_ENV);
  const errors: RuntimeEnvError[] = [];
  const apiPort = parsePort(env.API_PORT, 'API_PORT', errors);
  const apiBaseUrl = requireUrl(env.API_BASE_URL, 'API_BASE_URL', errors);
  const databaseUrl = requireString(env.DATABASE_URL, 'DATABASE_URL', errors);
  const botServiceToken = requireString(env.BOT_SERVICE_TOKEN, 'BOT_SERVICE_TOKEN', errors);
  const discordBotToken = env.DISCORD_BOT_TOKEN?.trim();

  if (!options.allowMissingDiscordToken && !discordBotToken) {
    errors.push({
      field: 'DISCORD_BOT_TOKEN',
      code: 'REQUIRED',
      message: 'DISCORD_BOT_TOKEN is required when the Discord adapter is expected to login.'
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    values: {
      nodeEnv,
      apiPort,
      apiBaseUrl: apiBaseUrl ?? '',
      databaseUrl: databaseUrl ?? '',
      botServiceToken: botServiceToken ?? '',
      discordBotToken
    }
  };
}

function normalizeNodeEnv(value: string | undefined): 'development' | 'test' | 'production' {
  if (value === 'production' || value === 'test') {
    return value;
  }
  return 'development';
}

function requireString(
  value: string | undefined,
  field: string,
  errors: RuntimeEnvError[]
): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    errors.push({
      field,
      code: 'REQUIRED',
      message: `${field} is required.`
    });
    return undefined;
  }
  return normalized;
}

function requireUrl(
  value: string | undefined,
  field: string,
  errors: RuntimeEnvError[]
): string | undefined {
  const normalized = requireString(value, field, errors);
  if (!normalized) {
    return undefined;
  }
  try {
    new URL(normalized);
    return normalized;
  } catch {
    errors.push({
      field,
      code: 'INVALID_URL',
      message: `${field} must be a valid URL.`
    });
    return undefined;
  }
}

function parsePort(
  value: string | undefined,
  field: string,
  errors: RuntimeEnvError[]
): number {
  if (value === undefined || value.trim() === '') {
    return DEFAULT_API_PORT;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    errors.push({
      field,
      code: 'INVALID_PORT',
      message: `${field} must be an integer between 0 and 65535.`
    });
    return DEFAULT_API_PORT;
  }
  return parsed;
}
