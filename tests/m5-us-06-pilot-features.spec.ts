import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildCapabilities } from '@blackcat/api/dashboard-auth';
import {
  createPilotFeaturePolicy,
  parsePilotPhase
} from '@blackcat/api/pilot-features';
import { buildApiServer } from '@blackcat/api/server';
import {
  InMemoryAuditSink,
  InMemoryIdempotencyStore,
  registerSecureReadRoute,
  registerSecureWriteRoute
} from '@blackcat/api/security';

describe('M5-US-06 PilotFeaturePolicy', () => {
  it('maps the two pilot waves and OFF to the frozen feature matrix', () => {
    expect(createPilotFeaturePolicy('CORE_ORDER').enabledFeatures).toEqual(['CORE_ORDER']);
    expect(createPilotFeaturePolicy('CORE_ORDER_AND_GIFTS').enabledFeatures).toEqual(['CORE_ORDER', 'GIFTS']);
    expect(createPilotFeaturePolicy('OFF').enabledFeatures).toEqual(['CORE_ORDER', 'GIFTS', 'REFERRALS', 'M6']);
  });

  it('rejects missing or unknown startup phases', () => {
    expect(() => parsePilotPhase(undefined)).toThrow(/PILOT_PHASE/u);
    expect(() => parsePilotPhase('FULL')).toThrow(/PILOT_PHASE/u);
    expect(() => createPilotFeaturePolicy('ALL')).toThrow(/PILOT_PHASE/u);
  });

  it('rejects disabled reads and writes before handlers or downstream effects', async () => {
    const audit = new InMemoryAuditSink();
    const idempotency = new InMemoryIdempotencyStore();
    const handler = vi.fn();
    const readHandler = vi.fn();
    const server = buildApiServer({
      env: runtimeEnv(),
      security: {
        auditSink: audit,
        idempotencyStore: idempotency,
        pilotFeaturePolicy: createPilotFeaturePolicy('CORE_ORDER'),
        dashboardSessions: {
          resolve: () => ({
            ok: true as const,
            staff: {
              staffId: '00000000-0000-0000-0000-000000000010',
              userId: '00000000-0000-0000-0000-000000000011',
              level: 'L4_ADMIN_OWNER' as const,
              permissionsVersion: 1,
              status: 'ACTIVE' as const
            },
            csrfToken: 'csrf'
          }),
          verifyCsrf: vi.fn(),
          verifyRecentStepUp: vi.fn()
        }
      }
    });
    registerSecureWriteRoute(server, server.securityOptions!, {
      method: 'POST',
      url: '/__m5/pilot-disabled-gift',
      permission: 'gift.approve',
      action: 'PILOT_DISABLED_GIFT_PROBE',
      targetType: 'gift_request',
      requiredFeature: 'GIFTS',
      handler
    });
    registerSecureReadRoute(server, server.securityOptions!, {
      method: 'GET',
      url: '/__m5/pilot-disabled-gift',
      permission: 'gift.approve',
      action: 'PILOT_DISABLED_GIFT_READ_PROBE',
      targetType: 'gift_request',
      requiredFeature: 'GIFTS',
      handler: readHandler
    });

    const response = await server.inject({
      method: 'POST',
      url: '/__m5/pilot-disabled-gift',
      headers: { cookie: 'p0_session=owner', 'x-client-source': 'DASHBOARD' }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: {
      code: 'FEATURE_DISABLED',
      details: [{ field: 'feature', reason: 'GIFTS' }]
    } });
    expect(handler).not.toHaveBeenCalled();
    expect(server.securityOptions?.dashboardSessions?.verifyCsrf).not.toHaveBeenCalled();
    expect(server.securityOptions?.dashboardSessions?.verifyRecentStepUp).not.toHaveBeenCalled();
    expect(idempotency.scopeKeys).toEqual([]);
    expect(audit.records).toContainEqual(expect.objectContaining({
      action: 'PILOT_DISABLED_GIFT_PROBE',
      outcome: 'REJECTED',
      reason: 'FEATURE_DISABLED:GIFTS'
    }));

    const readResponse = await server.inject({
      method: 'GET',
      url: '/__m5/pilot-disabled-gift',
      headers: { cookie: 'p0_session=owner', 'x-client-source': 'DASHBOARD' }
    });
    expect(readResponse.statusCode).toBe(409);
    expect(readResponse.json()).toMatchObject({ error: { code: 'FEATURE_DISABLED' } });
    expect(readHandler).not.toHaveBeenCalled();
    expect(audit.records).toContainEqual(expect.objectContaining({
      action: 'PILOT_DISABLED_GIFT_READ_PROBE',
      outcome: 'REJECTED',
      reason: 'FEATURE_DISABLED:GIFTS'
    }));
  });

  it('publishes API-authoritative enabled features and business environment in capabilities', async () => {
    await expect(buildCapabilities(
      '00000000-0000-0000-0000-000000000010',
      'L4_ADMIN_OWNER',
      7,
      undefined,
      undefined,
      new Date('2026-07-19T12:00:00.000Z'),
      undefined,
      {
        pilotFeaturePolicy: createPilotFeaturePolicy('CORE_ORDER_AND_GIFTS'),
        businessEnvironment: 'SANDBOX'
      }
    )).resolves.toMatchObject({
      enabledFeatures: ['CORE_ORDER', 'GIFTS'],
      businessEnvironment: 'SANDBOX'
    });
  });

  it('keeps the closed capabilities schema synchronized with the Pilot payload', () => {
    const openapi = readFileSync('outputs/P0开发交付包/02-API/openapi.yaml', 'utf8');
    expect(openapi).toContain('required: [staffId, level, scope, permissions, thresholds, mfa, stepUp, enabledFeatures, businessEnvironment, permissionsVersion]');
    expect(openapi).toContain('items: {type: string, enum: [CORE_ORDER, GIFTS, REFERRALS, M6]}');
    expect(openapi).toContain('businessEnvironment: {type: string, enum: [SANDBOX, PRODUCTION]}');
  });
});

function runtimeEnv() {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: '',
    API_PORT: '0',
    API_BASE_URL: 'http://localhost:3000',
    BOT_SERVICE_TOKEN: 'test-token'
  };
}
