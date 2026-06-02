const REQUIRED_PRODUCTION_ENV = [
  'DATABASE_URL', 'MIGRATION_DATABASE_URL', 'API_BASE_URL', 'BOT_SERVICE_TOKEN', 'BOT_CONFIG_VALIDATION_SECRET',
  'DASHBOARD_CSRF_SECRET', 'DASHBOARD_MFA_ENCRYPTION_KEY', 'DISCORD_BOT_TOKEN', 'DISCORD_OAUTH_CLIENT_ID',
  'DISCORD_OAUTH_CLIENT_SECRET', 'DISCORD_OAUTH_REDIRECT_URI', 'DISCORD_GUILD_ID', 'DASHBOARD_URL',
  'BUSINESS_ENV', 'PILOT_PHASE'
];

const SENSITIVE_PRODUCTION_ENV = new Set([
  'BOT_SERVICE_TOKEN', 'BOT_CONFIG_VALIDATION_SECRET', 'DASHBOARD_CSRF_SECRET', 'DASHBOARD_MFA_ENCRYPTION_KEY',
  'DISCORD_BOT_TOKEN', 'DISCORD_OAUTH_CLIENT_SECRET'
]);

/**
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
export function validateProductionEnv(env) {
  const errors = [];
  if (env.NODE_ENV !== 'production') errors.push('NODE_ENV must be production.');
  for (const key of REQUIRED_PRODUCTION_ENV) {
    validateRequiredValue(env, key, errors);
  }
  if (!['SANDBOX', 'PRODUCTION'].includes(env.BUSINESS_ENV ?? '')) {
    errors.push('BUSINESS_ENV must be SANDBOX or PRODUCTION.');
  }
  if (!['CORE_ORDER', 'CORE_ORDER_AND_GIFTS', 'OFF'].includes(env.PILOT_PHASE ?? '')) {
    errors.push('PILOT_PHASE must be CORE_ORDER, CORE_ORDER_AND_GIFTS, or OFF.');
  }
  if (env.DATABASE_URL && env.MIGRATION_DATABASE_URL && env.DATABASE_URL === env.MIGRATION_DATABASE_URL) {
    errors.push('Application and migration database credentials must be separate.');
  }
  if (env.API_BASE_URL && !isAllowedApiBaseUrl(env.API_BASE_URL)) {
    errors.push('API_BASE_URL must use HTTPS or Railway private HTTP.');
  }
  for (const key of [
    'DISCORD_OAUTH_REDIRECT_URI',
    'DASHBOARD_URL'
  ]) {
    const value = env[key];
    if (value && !isHttps(value)) errors.push(`${key} must use HTTPS.`);
  }
  if (env.DISCORD_GUILD_ID && !/^[0-9]{17,20}$/u.test(env.DISCORD_GUILD_ID)) {
    errors.push('DISCORD_GUILD_ID must be a Discord snowflake.');
  }
  return errors;
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {string} key
 * @param {string[]} errors
 */
function validateRequiredValue(env, key, errors) {
  const value = env[key]?.trim() ?? '';
  if (!value) {
    errors.push(`${key} is required.`);
  } else if (/change-me|replace-me|not-for-production|set_in_secret_store/iu.test(value)) {
    errors.push(`${key} must not use a placeholder value.`);
  } else if (
    SENSITIVE_PRODUCTION_ENV.has(key)
    && value.length < 32
  ) {
    errors.push(`${key} must be at least 32 characters.`);
  }
}

/** @param {string} value */
function isHttps(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/** @param {string} value */
function isAllowedApiBaseUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname.endsWith('.railway.internal'));
  } catch {
    return false;
  }
}
