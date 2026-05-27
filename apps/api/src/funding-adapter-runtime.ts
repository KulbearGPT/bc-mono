import { HttpFundingAdapter } from './http-payment-adapter.js';
import type { Pool } from 'pg';
import type { FundingAdapter } from './payment-adapter.js';
import { PostgresSandboxFundingStore, SandboxFundingAdapter } from './sandbox-funding.js';

export interface RuntimeFundingAdapter {
  adapter: FundingAdapter;
  providerKey: string;
}

export function createRuntimeFundingAdapter(
  env: Record<string, string | undefined>,
  dependencies: { pool: Pool }
): RuntimeFundingAdapter {
  const businessEnvironment = requireEnum(env, 'BUSINESS_ENV', ['SANDBOX', 'PRODUCTION'] as const);
  const adapterKind = requireEnum(env, 'FUNDING_ADAPTER', ['SANDBOX', 'HTTP_PROVIDER'] as const);
  if (businessEnvironment === 'PRODUCTION' && adapterKind === 'SANDBOX') {
    throw new Error('FUNDING_ADAPTER=SANDBOX is forbidden when BUSINESS_ENV=PRODUCTION.');
  }
  if (adapterKind === 'SANDBOX') {
    const bindingSecret = requireSecret(env, 'SANDBOX_BINDING_CODE_SECRET', 32);
    return {
      adapter: new SandboxFundingAdapter({ store: new PostgresSandboxFundingStore(dependencies.pool), bindingSecret }),
      providerKey: 'sandbox-provider'
    };
  }
  const providerKey = requireValue(env, 'PAYMENT_PROVIDER_KEY');
  const baseUrl = requireValue(env, 'PAYMENT_PROVIDER_BASE_URL');
  const serviceToken = requireSecret(env, 'PAYMENT_PROVIDER_SERVICE_TOKEN', 32);
  const webhookSecret = requireSecret(env, 'PAYMENT_PROVIDER_WEBHOOK_SECRET', 32);
  try {
    new URL(baseUrl);
  } catch {
    throw new Error('PAYMENT_PROVIDER_BASE_URL must be a valid URL.');
  }
  return {
    adapter: new HttpFundingAdapter({ baseUrl, serviceToken, providerKey, webhookSecret }),
    providerKey
  };
}

function requireValue(env: Record<string, string | undefined>, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required.`);
  return value;
}

function requireSecret(env: Record<string, string | undefined>, key: string, minimumLength: number): string {
  const value = requireValue(env, key);
  if (value.length < minimumLength) throw new Error(`${key} must be at least ${minimumLength} characters.`);
  return value;
}

function requireEnum<const T extends readonly string[]>(env: Record<string, string | undefined>, key: string, values: T): T[number] {
  const value = env[key]?.trim();
  if (!value || !values.includes(value)) throw new Error(`${key} must be ${values.join(' or ')}.`);
  return value as T[number];
}
