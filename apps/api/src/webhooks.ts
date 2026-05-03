import type { FastifyInstance, FastifyRequest } from 'fastify';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { AdapterError, type MockFundingAdapter } from './payment-adapter.js';

export type PaymentWebhookFundingAdapter = Pick<MockFundingAdapter, 'verifyWebhook'>;

export interface PaymentWebhookStore {
  get(providerKey: string, providerEventId: string): PaymentWebhookAcknowledgement | null;
  set(providerKey: string, providerEventId: string, acknowledgement: PaymentWebhookAcknowledgement): void;
}

export interface PaymentWebhookAcknowledgement {
  providerEventId: string;
  eventType: 'DEBIT_UPDATED' | 'REFUND_UPDATED';
  status: 'UNKNOWN' | 'PENDING' | 'SUCCEEDED' | 'FAILED';
  duplicate: boolean;
  applied: boolean;
  transactionId: string | null;
}

interface VerifiedTransactionEvent {
  eventId: string;
  resourceType: 'TRANSACTION';
  eventType: 'DEBIT_UPDATED' | 'REFUND_UPDATED';
  transactionStatus: 'UNKNOWN' | 'PENDING' | 'SUCCEEDED' | 'FAILED';
}

const rawWebhookBodies = new WeakMap<FastifyRequest, Buffer>();

export class InMemoryPaymentWebhookStore implements PaymentWebhookStore {
  private readonly acknowledgements = new Map<string, PaymentWebhookAcknowledgement>();

  get(providerKey: string, providerEventId: string): PaymentWebhookAcknowledgement | null {
    return clone(this.acknowledgements.get(this.key(providerKey, providerEventId))) ?? null;
  }

  set(providerKey: string, providerEventId: string, acknowledgement: PaymentWebhookAcknowledgement): void {
    this.acknowledgements.set(this.key(providerKey, providerEventId), clone(acknowledgement));
  }

  private key(providerKey: string, providerEventId: string): string {
    return `${providerKey}:${providerEventId}`;
  }
}

export function registerPaymentWebhookRoutes(
  server: FastifyInstance,
  options: {
    fundingAdapter: PaymentWebhookFundingAdapter;
    providerKey: string;
    now?: () => Date;
    store?: PaymentWebhookStore;
  }
): void {
  const now = options.now ?? (() => new Date());
  const store = options.store ?? new InMemoryPaymentWebhookStore();
  if (!server.hasContentTypeParser('application/octet-stream')) {
    server.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) => {
      done(null, body);
    });
  }
  server.addHook('preParsing', async (request, _reply, payload) => {
    if (!request.url.startsWith('/api/v1/webhooks/payment/')) {
      return payload;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of payload) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const rawBody = Buffer.concat(chunks);
    rawWebhookBodies.set(request, rawBody);
    return Readable.from(rawBody);
  });

  server.post('/api/v1/webhooks/payment/:providerKey', async (request, reply) => {
    const requestId = readRequestId(request);
    const providerKey = readProviderKey(request);
    if (providerKey !== options.providerKey) {
      reply.code(404);
      return {
        requestId,
        error: {
          code: 'RESOURCE_NOT_FOUND',
          message: 'Payment provider is not configured.',
          retryable: false,
          details: []
        }
      };
    }

    try {
      const verified = options.fundingAdapter.verifyWebhook({
        headers: normalizeHeaders(request.headers),
        rawBodyBase64: (rawWebhookBodies.get(request) ?? normalizeRawBody(request.body)).toString('base64'),
        receivedAt: now().toISOString()
      });
      const event = verified.event as VerifiedTransactionEvent;
      if (event.resourceType !== 'TRANSACTION') {
        throw new AdapterError('SCHEMA_MISMATCH', 'Webhook event resource is not supported by this endpoint.');
      }

      const existing = store.get(providerKey, event.eventId);
      if (existing) {
        return {
          requestId,
          data: {
            ...existing,
            duplicate: true
          }
        };
      }

      const acknowledgement: PaymentWebhookAcknowledgement = {
        providerEventId: event.eventId,
        eventType: event.eventType,
        status: event.transactionStatus,
        duplicate: false,
        applied: false,
        transactionId: null
      };
      store.set(providerKey, event.eventId, acknowledgement);
      return {
        requestId,
        data: acknowledgement
      };
    } catch (error) {
      const mapped = mapWebhookError(error);
      reply.code(mapped.statusCode);
      return {
        requestId,
        error: {
          code: mapped.code,
          message: mapped.message,
          retryable: mapped.retryable,
          details: []
        }
      };
    }
  });
}

function readProviderKey(request: FastifyRequest): string {
  const params = request.params as { providerKey?: string };
  return params.providerKey ?? '';
}

function readRequestId(request: FastifyRequest): string {
  const value = request.headers['x-request-id'];
  if (Array.isArray(value)) {
    return value[0] ?? `req_${crypto.randomUUID()}`;
  }
  return value ?? `req_${crypto.randomUUID()}`;
}

function normalizeHeaders(headers: FastifyRequest['headers']): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      result[key] = value.join(',');
    } else if (value !== undefined) {
      result[key] = String(value);
    }
  }
  return result;
}

function normalizeRawBody(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (typeof body === 'string') {
    return Buffer.from(body);
  }
  if (body === undefined || body === null) {
    return Buffer.alloc(0);
  }
  return Buffer.from(JSON.stringify(body));
}

function mapWebhookError(error: unknown): {
  statusCode: number;
  code: string;
  message: string;
  retryable: boolean;
} {
  if (error instanceof AdapterError) {
    if (error.code === 'SIGNATURE_INVALID' || error.code === 'REPLAY_REJECTED') {
      return { statusCode: 401, code: error.code, message: error.message, retryable: error.retryable };
    }
    if (error.code === 'SCHEMA_MISMATCH' || error.code === 'VALIDATION_ERROR') {
      return { statusCode: 400, code: 'VALIDATION_ERROR', message: error.message, retryable: error.retryable };
    }
    return { statusCode: 503, code: 'PROVIDER_UNAVAILABLE', message: error.message, retryable: error.retryable };
  }
  return {
    statusCode: 503,
    code: 'PROVIDER_UNAVAILABLE',
    message: 'Payment webhook verification failed.',
    retryable: false
  };
}

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}
