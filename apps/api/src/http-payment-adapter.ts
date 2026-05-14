import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  AdapterError,
  type FundingAdapter,
  type CaptureHoldInput,
  type CreateHoldInput,
  type CreateRefundInput,
  type CreateReservationDebitInput,
  type MockFundingAdapter,
  type ReleaseHoldInput
} from './payment-adapter.js';

type Capabilities = ReturnType<MockFundingAdapter['discoverCapabilities']>;
type ResolvedUser = ReturnType<MockFundingAdapter['resolveUser']>;
type ProviderBalance = ReturnType<MockFundingAdapter['getProviderBalance']>;
type Hold = ReturnType<MockFundingAdapter['getHold']>;
type Transaction = ReturnType<MockFundingAdapter['getTransaction']>;
type VerifiedWebhook = ReturnType<MockFundingAdapter['verifyWebhook']>;

export interface HttpFundingAdapterOptions {
  baseUrl: string;
  serviceToken: string;
  providerKey: string;
  webhookSecret: string;
  timeoutMs?: number;
  replayWindowSeconds?: number;
  timestampHeader?: string;
  signatureHeader?: string;
  capabilitiesPath?: string;
  fetchImplementation?: typeof fetch;
}

export class HttpFundingAdapter implements FundingAdapter {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly replayWindowSeconds: number;
  private readonly timestampHeader: string;
  private readonly signatureHeader: string;
  private readonly fetchImplementation: typeof fetch;

  constructor(private readonly options: HttpFundingAdapterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/u, '');
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.replayWindowSeconds = options.replayWindowSeconds ?? 300;
    this.timestampHeader = (options.timestampHeader ?? 'x-provider-timestamp').toLowerCase();
    this.signatureHeader = (options.signatureHeader ?? 'x-provider-signature').toLowerCase();
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    if (!/^https:\/\//u.test(this.baseUrl) && !/^http:\/\/(?:127\.0\.0\.1|localhost)(?::[0-9]+)?$/u.test(this.baseUrl)) {
      throw new Error('Payment Provider base URL must use HTTPS outside localhost.');
    }
    for (const [field, value] of [['serviceToken', options.serviceToken], ['webhookSecret', options.webhookSecret]] as const) {
      if (value.length < 32) throw new Error(`${field} must be at least 32 characters.`);
    }
  }

  discoverCapabilities(): Promise<Capabilities> {
    return this.request('GET', this.options.capabilitiesPath ?? '/adapter/v1/capabilities');
  }

  resolveUser(input: Parameters<MockFundingAdapter['resolveUser']>[0]): Promise<ResolvedUser> {
    return this.request('POST', '/adapter/v1/users:resolve', input);
  }

  getProviderBalance(input: Parameters<MockFundingAdapter['getProviderBalance']>[0]): Promise<ProviderBalance> {
    return this.request('GET', `/adapter/v1/users/${encodeURIComponent(input.externalUserId)}/provider-balance`);
  }

  createHold(input: CreateHoldInput): Promise<Hold> {
    return this.request('POST', '/adapter/v1/holds', input, input.idempotencyKey);
  }

  getHold(input: Parameters<MockFundingAdapter['getHold']>[0]): Promise<Hold> {
    return this.request('GET', `/adapter/v1/holds/${encodeURIComponent(input.lookupValue)}?lookupType=${encodeURIComponent(input.lookupType)}`);
  }

  captureHold(input: CaptureHoldInput): Promise<Hold> {
    return this.request('POST', `/adapter/v1/holds/${encodeURIComponent(input.holdRef)}:capture`, input, input.idempotencyKey);
  }

  releaseHold(input: ReleaseHoldInput): Promise<Hold> {
    return this.request('POST', `/adapter/v1/holds/${encodeURIComponent(input.holdRef)}:release`, input, input.idempotencyKey);
  }

  createReservationDebit(input: CreateReservationDebitInput): Promise<Transaction> {
    return this.request('POST', '/adapter/v1/reservation-debits', input, input.idempotencyKey);
  }

  createRefund(input: CreateRefundInput): Promise<Transaction> {
    return this.request('POST', '/adapter/v1/refunds', input, input.idempotencyKey);
  }

  getTransaction(input: Parameters<MockFundingAdapter['getTransaction']>[0]): Promise<Transaction> {
    return this.request('GET', `/adapter/v1/transactions/${encodeURIComponent(input.lookupValue)}?lookupType=${encodeURIComponent(input.lookupType)}`);
  }

  verifyWebhook(input: Parameters<MockFundingAdapter['verifyWebhook']>[0]): VerifiedWebhook {
    const headers = Object.fromEntries(Object.entries(input.headers).map(([key, value]) => [key.toLowerCase(), value]));
    const timestamp = headers[this.timestampHeader];
    const signature = headers[this.signatureHeader];
    if (!timestamp || !signature) throw new AdapterError('SIGNATURE_INVALID', 'Webhook signature headers are missing.');
    const receivedAt = Date.parse(input.receivedAt);
    const signedAt = Date.parse(timestamp);
    if (!Number.isFinite(receivedAt) || !Number.isFinite(signedAt) || Math.abs(receivedAt - signedAt) > this.replayWindowSeconds * 1000) {
      throw new AdapterError('REPLAY_REJECTED', 'Webhook timestamp is outside the replay window.');
    }
    const rawBody = Buffer.from(input.rawBodyBase64, 'base64').toString();
    const expected = Buffer.from(createHmac('sha256', this.options.webhookSecret).update(`${timestamp}.${rawBody}`).digest('hex'), 'hex');
    let actual: Buffer;
    try { actual = Buffer.from(signature, 'hex'); } catch { throw new AdapterError('SIGNATURE_INVALID', 'Webhook signature is invalid.'); }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new AdapterError('SIGNATURE_INVALID', 'Webhook signature is invalid.');
    let event: unknown;
    try { event = JSON.parse(rawBody); } catch { throw new AdapterError('SCHEMA_MISMATCH', 'Webhook body is not valid JSON.'); }
    if (!event || typeof event !== 'object' || typeof (event as { eventId?: unknown }).eventId !== 'string') {
      throw new AdapterError('SCHEMA_MISMATCH', 'Webhook event shape is invalid.');
    }
    return { verified: true, event } as VerifiedWebhook;
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    const requestId = `req_${randomUUID()}`;
    let response: Response;
    try {
      response = await this.fetchImplementation(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.options.serviceToken}`,
          accept: 'application/json',
          'content-type': 'application/json',
          'x-request-id': requestId,
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {})
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch {
      throw new AdapterError('PROVIDER_TIMEOUT', 'Payment Provider request timed out.', { retryable: true, requestId });
    }
    const payload = await response.json().catch(() => null) as { data?: T; error?: { code?: string; message?: string; retryable?: boolean; details?: Array<{field:string;reason:string}> } } | null;
    if (!response.ok) {
      const code = normalizeErrorCode(payload?.error?.code);
      throw new AdapterError(code, payload?.error?.message ?? 'Payment Provider request failed.', {
        retryable: payload?.error?.retryable ?? response.status >= 500,
        requestId,
        providerHttpStatus: response.status,
        details: payload?.error?.details ?? []
      });
    }
    const data = payload?.data ?? payload as T | null;
    if (data === null || data === undefined) throw new AdapterError('SCHEMA_MISMATCH', 'Payment Provider returned an empty response.', { requestId, providerHttpStatus: response.status });
    return data as T;
  }
}

function normalizeErrorCode(value: string | undefined): AdapterError['code'] {
  const known: AdapterError['code'][] = ['VALIDATION_ERROR','RESOURCE_NOT_FOUND','IDEMPOTENCY_CONFLICT','BUSINESS_RULE_VIOLATION','INSUFFICIENT_FUNDS','RESERVATION_CONFLICT','PROVIDER_TIMEOUT','SIGNATURE_INVALID','REPLAY_REJECTED','SCHEMA_MISMATCH','REFUND_AMOUNT_EXCEEDED'];
  return known.includes(value as AdapterError['code']) ? value as AdapterError['code'] : 'PROVIDER_TIMEOUT';
}
