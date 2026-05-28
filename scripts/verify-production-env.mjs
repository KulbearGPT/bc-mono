import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const required = [
  'DATABASE_URL', 'MIGRATION_DATABASE_URL', 'API_BASE_URL', 'BOT_SERVICE_TOKEN', 'BOT_CONFIG_VALIDATION_SECRET',
  'DASHBOARD_CSRF_SECRET', 'DASHBOARD_MFA_ENCRYPTION_KEY', 'DISCORD_BOT_TOKEN', 'DISCORD_OAUTH_CLIENT_ID',
  'DISCORD_OAUTH_CLIENT_SECRET', 'DISCORD_OAUTH_REDIRECT_URI', 'DISCORD_GUILD_ID', 'DASHBOARD_URL',
  'BUSINESS_ENV', 'FUNDING_ADAPTER', 'PILOT_PHASE'
];
const sensitive = new Set([
  'BOT_SERVICE_TOKEN', 'BOT_CONFIG_VALIDATION_SECRET', 'DASHBOARD_CSRF_SECRET', 'DASHBOARD_MFA_ENCRYPTION_KEY',
  'DISCORD_BOT_TOKEN', 'DISCORD_OAUTH_CLIENT_SECRET', 'PAYMENT_PROVIDER_SERVICE_TOKEN', 'PAYMENT_PROVIDER_WEBHOOK_SECRET'
]);

export function validateProductionEnv(env) {
  const errors = [];
  if (env.NODE_ENV !== 'production') errors.push('NODE_ENV must be production.');
  for (const key of required) {
    const value = env[key]?.trim() ?? '';
    if (!value) errors.push(`${key} is required.`);
    else if (/change-me|replace-me|not-for-production|set_in_secret_store/iu.test(value)) errors.push(`${key} must not use a placeholder value.`);
    else if (sensitive.has(key) && value.length < 32) errors.push(`${key} must be at least 32 characters.`);
  }
  if (!['SANDBOX', 'PRODUCTION'].includes(env.BUSINESS_ENV)) errors.push('BUSINESS_ENV must be SANDBOX or PRODUCTION.');
  if (!['SANDBOX', 'HTTP_PROVIDER'].includes(env.FUNDING_ADAPTER)) errors.push('FUNDING_ADAPTER must be SANDBOX or HTTP_PROVIDER.');
  if (!['CORE_ORDER', 'CORE_ORDER_AND_GIFTS', 'OFF'].includes(env.PILOT_PHASE)) errors.push('PILOT_PHASE must be CORE_ORDER, CORE_ORDER_AND_GIFTS, or OFF.');
  if (env.BUSINESS_ENV === 'PRODUCTION' && env.FUNDING_ADAPTER === 'SANDBOX') {
    errors.push('FUNDING_ADAPTER=SANDBOX is forbidden when BUSINESS_ENV=PRODUCTION.');
  }
  const adapterRequired = env.FUNDING_ADAPTER === 'SANDBOX'
    ? ['SANDBOX_BINDING_CODE_SECRET']
    : ['PAYMENT_PROVIDER_BASE_URL', 'PAYMENT_PROVIDER_SERVICE_TOKEN', 'PAYMENT_PROVIDER_WEBHOOK_SECRET', 'PAYMENT_PROVIDER_KEY'];
  for (const key of adapterRequired) {
    const value = env[key]?.trim() ?? '';
    if (!value) errors.push(`${key} is required.`);
    else if (/change-me|replace-me|not-for-production|set_in_secret_store/iu.test(value)) errors.push(`${key} must not use a placeholder value.`);
    else if (sensitive.has(key) || key === 'SANDBOX_BINDING_CODE_SECRET') {
      if (value.length < 32) errors.push(`${key} must be at least 32 characters.`);
    }
  }
  if (env.DATABASE_URL && env.MIGRATION_DATABASE_URL && env.DATABASE_URL === env.MIGRATION_DATABASE_URL) {
    errors.push('Application and migration database credentials must be separate.');
  }
  if (env.API_BASE_URL && !isAllowedApiBaseUrl(env.API_BASE_URL)) errors.push('API_BASE_URL must use HTTPS or Railway private HTTP.');
  for (const key of ['DISCORD_OAUTH_REDIRECT_URI', 'DASHBOARD_URL', ...(env.FUNDING_ADAPTER === 'HTTP_PROVIDER' ? ['PAYMENT_PROVIDER_BASE_URL'] : [])]) {
    const value = env[key];
    if (value && !isHttps(value)) errors.push(`${key} must use HTTPS.`);
  }
  if (env.DISCORD_GUILD_ID && !/^[0-9]{17,20}$/u.test(env.DISCORD_GUILD_ID)) errors.push('DISCORD_GUILD_ID must be a Discord snowflake.');
  return errors;
}

function isHttps(value) { try { return new URL(value).protocol === 'https:'; } catch { return false; } }
function isAllowedApiBaseUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname.endsWith('.railway.internal'));
  } catch { return false; }
}
function parseEnv(text) {
  return Object.fromEntries(text.split(/\r?\n/u).filter((line) => line && !line.startsWith('#')).map((line) => {
    const index = line.indexOf('='); return index < 0 ? [line, ''] : [line.slice(0, index), line.slice(index + 1)];
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = resolve(process.argv[2] ?? '.env.production');
  const errors = validateProductionEnv(parseEnv(await readFile(path, 'utf8')));
  if (errors.length) { process.stderr.write(`${errors.join('\n')}\n`); process.exitCode = 1; }
  else process.stdout.write('production-env-ok\n');
}
