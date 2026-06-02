import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

describe('M0-US-04 retired payment integration', () => {
  test('has been superseded by the internal USD wallet', () => {
    for (const path of ['apps/api/src/payment-adapter.ts', 'apps/api/src/http-payment-adapter.ts',
      'apps/api/src/funding-adapter-runtime.ts', 'apps/api/src/webhooks.ts']) {
      expect(existsSync(path)).toBe(false);
    }
    const server = readFileSync('apps/api/src/server.ts', 'utf8');
    expect(server).not.toMatch(/paymentWebhook|fundingAdapter|PAYMENT_PROVIDER/u);
  });
});
