import { HttpFundingAdapter } from './http-payment-adapter.js';
import { MockFundingAdapter, type FundingAdapter } from './payment-adapter.js';

export interface RuntimeFundingAdapter {
  adapter: FundingAdapter;
  providerKey: string;
}

export function createRuntimeFundingAdapter(
  env: Record<string, string | undefined>
): RuntimeFundingAdapter {
  const providerKey = env.PAYMENT_PROVIDER_KEY?.trim();
  const baseUrl = env.PAYMENT_PROVIDER_BASE_URL?.trim();
  const serviceToken = env.PAYMENT_PROVIDER_SERVICE_TOKEN?.trim();
  const webhookSecret = env.PAYMENT_PROVIDER_WEBHOOK_SECRET?.trim();
  const configuredValues = [providerKey, baseUrl, serviceToken, webhookSecret];
  const hasAnyProviderConfig = configuredValues.some(Boolean);

  if (!hasAnyProviderConfig && env.NODE_ENV !== 'production') {
    return { adapter: new MockFundingAdapter(), providerKey: 'mock-provider' };
  }

  const missing = [
    ['PAYMENT_PROVIDER_KEY', providerKey],
    ['PAYMENT_PROVIDER_BASE_URL', baseUrl],
    ['PAYMENT_PROVIDER_SERVICE_TOKEN', serviceToken],
    ['PAYMENT_PROVIDER_WEBHOOK_SECRET', webhookSecret]
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`Payment Provider configuration is incomplete: ${missing.join(', ')}`);
  }
  if (serviceToken!.length < 32) {
    throw new Error('PAYMENT_PROVIDER_SERVICE_TOKEN must be at least 32 characters.');
  }
  if (webhookSecret!.length < 32) {
    throw new Error('PAYMENT_PROVIDER_WEBHOOK_SECRET must be at least 32 characters.');
  }
  try {
    new URL(baseUrl!);
  } catch {
    throw new Error('PAYMENT_PROVIDER_BASE_URL must be a valid URL.');
  }

  return {
    adapter: new HttpFundingAdapter({
      baseUrl: baseUrl!,
      serviceToken: serviceToken!,
      providerKey: providerKey!,
      webhookSecret: webhookSecret!
    }),
    providerKey: providerKey!
  };
}
