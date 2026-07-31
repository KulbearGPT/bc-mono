import { describe, expect, test } from 'vitest';
import { buildApiServer } from '@blackcat/api/server';
import {
  InMemoryAccessStore,
  type StaffAccessRecord
} from '@blackcat/api/access';
import { InMemoryDashboardAuthStore } from '@blackcat/api/dashboard-auth';
import {
  InMemoryAuditSink,
  InMemoryIdempotencyStore,
  type StaffLevel
} from '@blackcat/api/security';

const env = {
  NODE_ENV: 'test',
  DATABASE_URL: '',
  API_PORT: '0',
  API_BASE_URL: 'http://localhost:3000',
  BOT_SERVICE_TOKEN: 'valid-bot-token'
};
const now = new Date('2026-07-18T18:00:00.000Z');
const guildId = '900000000000000001';
const roles = {
  L1_SUPPORT: '900000000000000101',
  L2_SUPERVISOR: '900000000000000102',
  L3_OPERATIONS: '900000000000000103',
  L4_ADMIN_OWNER: '900000000000000104'
} satisfies Record<StaffLevel, string>;

const ownerA = staff({
  staffId: '00000000-0000-0000-0000-000000005401',
  discordUserId: '900000000000000201',
  level: 'L4_ADMIN_OWNER',
  permissionsVersion: 8
});
const ownerB = staff({
  staffId: '00000000-0000-0000-0000-000000005402',
  discordUserId: '900000000000000202',
  level: 'L4_ADMIN_OWNER',
  permissionsVersion: 5
});
const targetL2 = staff({
  staffId: '00000000-0000-0000-0000-000000005403',
  discordUserId: '900000000000000203',
  level: 'L2_SUPERVISOR',
  permissionsVersion: 2
});
const targetL3 = staff({
  staffId: '00000000-0000-0000-0000-000000005404',
  discordUserId: '900000000000000204',
  level: 'L3_OPERATIONS',
  permissionsVersion: 3
});

function staff(input: {
  staffId: string;
  discordUserId: string;
  level: StaffLevel;
  permissionsVersion: number;
}): StaffAccessRecord {
  return {
    ...input,
    guildId,
    requestedLevel: null,
    status: 'ACTIVE',
    observedRoleIds: [roles[input.level]]
  };
}

function fixture(initialStaff: StaffAccessRecord[] = [ownerA, ownerB, targetL2, targetL3]) {
  const authStore = new InMemoryDashboardAuthStore();
  const auditSink = new InMemoryAuditSink();
  const idempotencyStore = new InMemoryIdempotencyStore();
  const store = new InMemoryAccessStore({
    authStore,
    staff: initialStaff,
    mappings: Object.entries(roles).map(([targetLevel, discordRoleId]) => ({
      guildId,
      discordRoleId,
      targetLevel: targetLevel as StaffLevel,
      enabled: true,
      version: 1,
      reconciliationQueued: false
    }))
  });
  const staffDirectory = store;
  const server = buildApiServer({
    env,
    security: {
      auditSink,
      idempotencyStore,
      staffDirectory,
      dashboardSessions: authStore,
      stepUpVerifier: {
        verify: ({ request }) => request.headers['x-test-step-up'] === 'valid'
      }
    },
    dashboardAuth: {
      store: authStore,
      oauth: {
        getAuthorizationUrl: ({ state }) => `https://discord.test/oauth?state=${state}`,
        exchangeCode: async () => ({ discordUserId: ownerA.discordUserId })
      },
      staffDirectory,
      guildId,
      dashboardUrl: 'https://dashboard.example.test',
      secureCookies: false,
      now: () => now
    },
    access: {
      store,
      now: () => now
    }
  });
  return { server, store, authStore, auditSink };
}

function adminHeaders(
  actor: StaffAccessRecord,
  key?: string,
  extra: Record<string, string> = {}
) {
  return {
    authorization: 'Bearer valid-bot-token',
    'x-client-source': 'DISCORD_BOT',
    'x-actor-discord-user-id': actor.discordUserId,
    'x-actor-guild-id': guildId,
    'x-discord-interaction-id': '900000000000000901',
    ...(key ? { 'idempotency-key': key } : {}),
    ...extra
  };
}

function roleSyncHeaders(key: string) {
  return {
    authorization: 'Bearer valid-bot-token',
    'x-client-source': 'DISCORD_BOT',
    'idempotency-key': key
  };
}

function sessionHeaders(session: { sessionToken: string; csrfToken: string }) {
  return {
    cookie: `p0_session=${session.sessionToken}; p0_csrf=${session.csrfToken}`,
    'x-csrf-token': session.csrfToken,
    'x-client-source': 'DASHBOARD'
  };
}

function sessionStaff(account: StaffAccessRecord) {
  return {
    staffId: account.staffId,
    userId: account.staffId,
    level: account.level,
    permissionsVersion: account.permissionsVersion,
    status: 'ACTIVE' as const
  };
}

function syncPayload(input: {
  discordUserId: string;
  observedRoleIds: string[];
  sourceEventId: string;
  mappingVersion?: number;
}) {
  return {
    guildId,
    discordUserId: input.discordUserId,
    observedRoleIds: input.observedRoleIds,
    mappingVersion: input.mappingVersion ?? 1,
    source: 'GUILD_MEMBER_UPDATE',
    sourceEventId: input.sourceEventId,
    observedAt: now.toISOString()
  };
}

describe('M4-US-05 Discord Role mapping and access API', () => {
  test('rejects malformed service observations and management writes without a reason', async () => {
    const { server } = fixture();
    const invalidObservation = await server.inject({
      method: 'POST',
      url: '/api/v1/internal/discord/role-sync',
      headers: roleSyncHeaders('access:role-sync:invalid-observation'),
      payload: {
        ...syncPayload({ discordUserId: targetL2.discordUserId, observedRoleIds: ['not-a-role'], sourceEventId: 'invalid-observation' }),
        source: 'CLIENT_ASSERTION'
      }
    });
    expect(invalidObservation.statusCode).toBe(400);
    expect(invalidObservation.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });

    const missingReason = await server.inject({
      method: 'PUT',
      url: '/api/v1/admin/discord-role-mappings/L2_SUPERVISOR',
      headers: adminHeaders(ownerA, 'access:mapping:missing-reason', { 'x-test-step-up': 'valid' }),
      payload: { guildId, discordRoleId: '900000000000000112', expectedVersion: 1, enabled: true }
    });
    expect(missingReason.statusCode).toBe(400);
    expect(missingReason.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  test('queues member observations durably and lets L4 queue one staff reconciliation', async () => {
    const { server, store } = fixture();
    const observation = await server.inject({
      method: 'POST',
      url: '/api/v1/internal/discord/role-sync/queue',
      headers: roleSyncHeaders('access:role-sync:queue-member-update'),
      payload: syncPayload({
        discordUserId: targetL2.discordUserId,
        observedRoleIds: [roles.L2_SUPERVISOR, roles.L3_OPERATIONS],
        sourceEventId: 'member-update:durable-queue'
      })
    });
    expect(observation.statusCode).toBe(202);
    expect(observation.json()).toMatchObject({
      data: {
        queued: true,
        persistent: true,
        staffId: targetL2.staffId,
        jobId: expect.any(String)
      }
    });

    const manual = await server.inject({
      method: 'POST',
      url: `/api/v1/admin/staff/${targetL2.staffId}/discord-role-reconcile`,
      headers: adminHeaders(ownerA, 'access:manual-role-reconcile', { 'x-test-step-up': 'valid' }),
      payload: { reasonCode: 'ROLE_SYNC_RECOVERY' }
    });
    expect(manual.statusCode, manual.body).toBe(202);
    expect(manual.json()).toMatchObject({
      data: { staffId: targetL2.staffId, status: 'QUEUED', jobId: expect.any(String) }
    });

    const listed = await store.listStaff({ guildId, cursor: null, limit: 100 });
    expect(listed.items).toContainEqual(expect.objectContaining({
      staffId: targetL2.staffId,
      observedDiscordRoleIds: [roles.L2_SUPERVISOR],
      roleSyncedAt: null,
      roleSyncQueueStatus: 'PENDING',
      lastRoleSyncError: null,
      pendingElevationLevel: null
    }));
  });

  test('lists current mappings and creates a new optimistic mapping version', async () => {
    const { server } = fixture();
    const listed = await server.inject({
      method: 'GET',
      url: '/api/v1/admin/discord-role-mappings',
      headers: adminHeaders(ownerA, undefined, { 'x-test-step-up': 'valid' })
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().data.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        guildId,
        discordRoleId: roles.L2_SUPERVISOR,
        targetLevel: 'L2_SUPERVISOR',
        enabled: true,
        version: 1
      })
    ]));

    const withoutStepUp = await server.inject({
      method: 'PUT',
      url: '/api/v1/admin/discord-role-mappings/L2_SUPERVISOR',
      headers: adminHeaders(ownerA, 'access:mapping:update:no-step-up'),
      payload: {
        guildId,
        discordRoleId: '900000000000000112',
        expectedVersion: 1,
        enabled: true,
        reasonCode: 'ROLE_CONFIGURATION_CHANGE'
      }
    });
    expect(withoutStepUp.statusCode).toBe(428);
    expect(withoutStepUp.json()).toMatchObject({ error: { code: 'STEP_UP_REQUIRED' } });

    const updated = await server.inject({
      method: 'PUT',
      url: '/api/v1/admin/discord-role-mappings/L2_SUPERVISOR',
      headers: adminHeaders(ownerA, 'access:mapping:update:version-2', { 'x-test-step-up': 'valid' }),
      payload: {
        guildId,
        discordRoleId: '900000000000000112',
        expectedVersion: 1,
        enabled: true,
        reasonCode: 'ROLE_CONFIGURATION_CHANGE'
      }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      data: {
        guildId,
        discordRoleId: '900000000000000112',
        targetLevel: 'L2_SUPERVISOR',
        enabled: true,
        version: 2,
        reconciliationQueued: true
      }
    });

    const after = await server.inject({
      method: 'GET',
      url: '/api/v1/admin/discord-role-mappings',
      headers: adminHeaders(ownerA, undefined, { 'x-test-step-up': 'valid' })
    });
    const l2Mappings = after.json().data.items.filter((item: { targetLevel: StaffLevel }) => (
      item.targetLevel === 'L2_SUPERVISOR'
    ));
    expect(l2Mappings).toEqual([
      expect.objectContaining({ discordRoleId: '900000000000000112', version: 2 })
    ]);

    const nextGeneration = await server.inject({
      method: 'PUT',
      url: '/api/v1/admin/discord-role-mappings/L3_OPERATIONS',
      headers: adminHeaders(ownerA, 'access:mapping:update:generation-3', { 'x-test-step-up': 'valid' }),
      payload: { guildId, discordRoleId: '900000000000000113', expectedVersion: 2, enabled: true, reasonCode: 'ROLE_CONFIGURATION_CHANGE' }
    });
    expect(nextGeneration.statusCode).toBe(200);
    expect(nextGeneration.json()).toMatchObject({ data: { targetLevel: 'L3_OPERATIONS', version: 3 } });
    const generationThree = await server.inject({ method: 'GET', url: '/api/v1/admin/discord-role-mappings', headers: adminHeaders(ownerA, undefined, { 'x-test-step-up': 'valid' }) });
    expect(new Set(generationThree.json().data.items.map((item: { version: number }) => item.version))).toEqual(new Set([3]));
  });

  test('applies L1 then L2 automatically and replays one source event without another mutation', async () => {
    const { server } = fixture();
    const discordUserId = '900000000000000205';
    const firstPayload = syncPayload({
      discordUserId,
      observedRoleIds: [roles.L1_SUPPORT],
      sourceEventId: 'member-update:auto-l1'
    });
    const first = await server.inject({
      method: 'POST',
      url: '/api/v1/internal/discord/role-sync',
      headers: roleSyncHeaders('access:role-sync:auto-l1:first'),
      payload: firstPayload
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      data: {
        discordUserId,
        previousLevel: null,
        requestedLevel: null,
        effectiveLevel: 'L1_SUPPORT',
        status: 'APPLIED',
        permissionsVersion: 1,
        sessionsRevoked: false
      }
    });

    const replay = await server.inject({
      method: 'POST',
      url: '/api/v1/internal/discord/role-sync',
      headers: roleSyncHeaders('access:role-sync:auto-l1:source-replay'),
      payload: firstPayload
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data).toEqual(first.json().data);

    const promoted = await server.inject({
      method: 'POST',
      url: '/api/v1/internal/discord/role-sync',
      headers: roleSyncHeaders('access:role-sync:auto-l2'),
      payload: syncPayload({
        discordUserId,
        observedRoleIds: [roles.L1_SUPPORT, roles.L2_SUPERVISOR],
        sourceEventId: 'member-update:auto-l2'
      })
    });
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json()).toMatchObject({
      data: {
        previousLevel: 'L1_SUPPORT',
        requestedLevel: null,
        effectiveLevel: 'L2_SUPERVISOR',
        status: 'APPLIED',
        permissionsVersion: 2,
        sessionsRevoked: true
      }
    });
  });

  test('keeps first L3 elevation pending and never trusts client-supplied Role claims', async () => {
    const { server } = fixture();
    const pending = await server.inject({
      method: 'POST',
      url: '/api/v1/internal/discord/role-sync',
      headers: roleSyncHeaders('access:role-sync:l3-pending'),
      payload: syncPayload({
        discordUserId: targetL2.discordUserId,
        observedRoleIds: [roles.L2_SUPERVISOR, roles.L3_OPERATIONS],
        sourceEventId: 'member-update:l3-pending'
      })
    });
    expect(pending.statusCode).toBe(202);
    expect(pending.json()).toMatchObject({
      data: {
        code: 'ROLE_ELEVATION_PENDING',
        staffId: targetL2.staffId,
        effectiveLevel: 'L2_SUPERVISOR',
        requestedLevel: 'L3_OPERATIONS',
        approvalRequestId: expect.any(String)
      }
    });

    const forged = await server.inject({
      method: 'GET',
      url: '/api/v1/admin/discord-role-mappings',
      headers: adminHeaders(targetL2, undefined, {
        'x-actor-level': 'L4_ADMIN_OWNER',
        'x-actor-role-id': roles.L4_ADMIN_OWNER,
        'x-discord-role-ids': roles.L4_ADMIN_OWNER,
        'x-test-step-up': 'valid'
      })
    });
    expect(forged.statusCode).toBe(403);
    expect(forged.json()).toMatchObject({ error: { code: 'PERMISSION_DENIED' } });
  });

  test('requires another stepped-up L4 and a still-observed Role to approve L4 elevation', async () => {
    const { server, store } = fixture();
    const pending = await server.inject({
      method: 'POST',
      url: '/api/v1/internal/discord/role-sync',
      headers: roleSyncHeaders('access:role-sync:l4-pending'),
      payload: syncPayload({
        discordUserId: targetL3.discordUserId,
        observedRoleIds: [roles.L3_OPERATIONS, roles.L4_ADMIN_OWNER],
        sourceEventId: 'member-update:l4-pending'
      })
    });
    expect(pending.statusCode).toBe(202);
    expect(pending.json()).toMatchObject({
      data: {
        staffId: targetL3.staffId,
        effectiveLevel: 'L3_OPERATIONS',
        requestedLevel: 'L4_ADMIN_OWNER'
      }
    });

    const selfApproval = await server.inject({
      method: 'POST',
      url: `/api/v1/admin/staff/${targetL3.staffId}/role-elevation/approve`,
      headers: adminHeaders(targetL3, 'access:elevation:self-approval', {
        'x-actor-level': 'L4_ADMIN_OWNER',
        'x-discord-role-ids': roles.L4_ADMIN_OWNER,
        'x-test-step-up': 'valid'
      }),
      payload: {
        expectedPermissionsVersion: 3,
        requestedLevel: 'L4_ADMIN_OWNER',
        reasonCode: 'ROLE_AND_IDENTITY_VERIFIED'
      }
    });
    expect(selfApproval.statusCode).toBe(403);
    expect(selfApproval.json()).toMatchObject({ error: { code: 'PERMISSION_DENIED' } });
    expect(() => store.approveElevation({
      targetStaffId: targetL3.staffId,
      actorStaffId: targetL3.staffId,
      expectedPermissionsVersion: 3,
      requestedLevel: 'L4_ADMIN_OWNER',
      now
    })).toThrowError(expect.objectContaining({ code: 'SELF_APPROVAL_FORBIDDEN' }));

    const withoutStepUp = await server.inject({
      method: 'POST',
      url: `/api/v1/admin/staff/${targetL3.staffId}/role-elevation/approve`,
      headers: adminHeaders(ownerA, 'access:elevation:l4:no-step-up'),
      payload: {
        expectedPermissionsVersion: 3,
        requestedLevel: 'L4_ADMIN_OWNER',
        reasonCode: 'ROLE_AND_IDENTITY_VERIFIED'
      }
    });
    expect(withoutStepUp.statusCode).toBe(428);
    expect(withoutStepUp.json()).toMatchObject({ error: { code: 'STEP_UP_REQUIRED' } });

    const approved = await server.inject({
      method: 'POST',
      url: `/api/v1/admin/staff/${targetL3.staffId}/role-elevation/approve`,
      headers: adminHeaders(ownerB, 'access:elevation:l4:approved', { 'x-test-step-up': 'valid' }),
      payload: {
        expectedPermissionsVersion: 3,
        requestedLevel: 'L4_ADMIN_OWNER',
        reasonCode: 'ROLE_AND_IDENTITY_VERIFIED'
      }
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({
      data: {
        staffId: targetL3.staffId,
        level: 'L4_ADMIN_OWNER',
        requestedLevel: null,
        status: 'ACTIVE',
        permissionsVersion: 4,
        sessionsRevoked: true
      }
    });

    const newlyAuthorized = await server.inject({
      method: 'GET',
      url: '/api/v1/admin/discord-role-mappings',
      headers: adminHeaders(targetL3, undefined, { 'x-test-step-up': 'valid' })
    });
    expect(newlyAuthorized.statusCode).toBe(200);

  });

  test('rejects approval after the required observed Role has disappeared', async () => {
    const { server } = fixture();
    const pending = await server.inject({
      method: 'POST',
      url: '/api/v1/internal/discord/role-sync',
      headers: roleSyncHeaders('access:role-sync:stale-observation:pending'),
      payload: syncPayload({
        discordUserId: targetL3.discordUserId,
        observedRoleIds: [roles.L3_OPERATIONS, roles.L4_ADMIN_OWNER],
        sourceEventId: 'member-update:stale-observation:pending'
      })
    });
    expect(pending.statusCode).toBe(202);

    const removed = await server.inject({
      method: 'POST',
      url: '/api/v1/internal/discord/role-sync',
      headers: roleSyncHeaders('access:role-sync:stale-observation:removed'),
      payload: syncPayload({
        discordUserId: targetL3.discordUserId,
        observedRoleIds: [roles.L3_OPERATIONS],
        sourceEventId: 'member-update:stale-observation:removed'
      })
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().data.requestedLevel).toBeNull();

    const staleApproval = await server.inject({
      method: 'POST',
      url: `/api/v1/admin/staff/${targetL3.staffId}/role-elevation/approve`,
      headers: adminHeaders(ownerA, 'access:elevation:stale-observation', { 'x-test-step-up': 'valid' }),
      payload: {
        expectedPermissionsVersion: removed.json().data.permissionsVersion,
        requestedLevel: 'L4_ADMIN_OWNER',
        reasonCode: 'ROLE_AND_IDENTITY_VERIFIED'
      }
    });
    expect(staleApproval.statusCode).toBe(409);
    expect(staleApproval.json().error.code).toMatch(/ROLE_(?:NOT_OBSERVED|ELEVATION_NOT_PENDING)/u);
  });

  test('immediately applies an observed Role downgrade and invalidates the prior Dashboard session', async () => {
    const { server, authStore } = fixture();
    const oldSession = await authStore.createSession(sessionStaff(targetL3), now);
    const downgraded = await server.inject({
      method: 'POST',
      url: '/api/v1/internal/discord/role-sync',
      headers: roleSyncHeaders('access:role-sync:observed-downgrade'),
      payload: syncPayload({
        discordUserId: targetL3.discordUserId,
        observedRoleIds: [roles.L1_SUPPORT],
        sourceEventId: 'member-update:observed-downgrade'
      })
    });
    expect(downgraded.statusCode).toBe(200);
    expect(downgraded.json()).toMatchObject({
      data: {
        previousLevel: 'L3_OPERATIONS',
        requestedLevel: null,
        effectiveLevel: 'L1_SUPPORT',
        status: 'APPLIED',
        permissionsVersion: 4,
        sessionsRevoked: true
      }
    });

    const staleSession = await server.inject({
      method: 'GET',
      url: '/api/v1/admin/me/capabilities',
      headers: sessionHeaders(oldSession)
    });
    expect(staleSession.statusCode).toBe(401);
    expect(staleSession.json()).toMatchObject({ error: { code: 'SESSION_REVOKED' } });
  });

  test('downgrades through the staff Role API, increments permissions version, and revokes old Dashboard sessions', async () => {
    const { server, authStore } = fixture();
    const oldSession = await authStore.createSession(sessionStaff(targetL3), now);
    const before = await server.inject({
      method: 'GET',
      url: '/api/v1/admin/me/capabilities',
      headers: sessionHeaders(oldSession)
    });
    expect(before.statusCode).toBe(200);

    const downgraded = await server.inject({
      method: 'PATCH',
      url: `/api/v1/admin/staff/${targetL3.staffId}/role`,
      headers: adminHeaders(ownerA, 'access:staff-role:downgrade-l1', { 'x-test-step-up': 'valid' }),
      payload: {
        expectedPermissionsVersion: 3,
        level: 'L1_SUPPORT',
        status: 'ACTIVE',
        reasonCode: 'MANUAL_DOWNGRADE'
      }
    });
    expect(downgraded.statusCode).toBe(200);
    expect(downgraded.json()).toMatchObject({
      data: {
        staffId: targetL3.staffId,
        level: 'L1_SUPPORT',
        requestedLevel: null,
        status: 'ACTIVE',
        permissionsVersion: 4,
        sessionsRevoked: true
      }
    });

    const staleSession = await server.inject({
      method: 'GET',
      url: '/api/v1/admin/me/capabilities',
      headers: sessionHeaders(oldSession)
    });
    expect(staleSession.statusCode).toBe(401);
    expect(staleSession.json()).toMatchObject({ error: { code: 'SESSION_REVOKED' } });
  });

  test('does not reactivate a manually revoked account and ignores an older observation after removal', async () => {
    const { server } = fixture();
    const revoked = await server.inject({
      method: 'PATCH',
      url: `/api/v1/admin/staff/${targetL2.staffId}/role`,
      headers: adminHeaders(ownerA, 'access:staff-role:manual-revoke', { 'x-test-step-up': 'valid' }),
      payload: { expectedPermissionsVersion: 2, level: 'L2_SUPERVISOR', status: 'REVOKED', reasonCode: 'SECURITY_REVOKE' }
    });
    expect(revoked.statusCode).toBe(200);

    const attemptedRestore = await server.inject({
      method: 'POST',
      url: '/api/v1/internal/discord/role-sync',
      headers: roleSyncHeaders('access:role-sync:manual-revoke-restore'),
      payload: syncPayload({ discordUserId: targetL2.discordUserId, observedRoleIds: [roles.L2_SUPERVISOR], sourceEventId: 'manual-revoke-restore' })
    });
    expect(attemptedRestore.statusCode).toBe(200);
    expect(attemptedRestore.json()).toMatchObject({ data: { effectiveLevel: null, status: 'NO_CHANGE', permissionsVersion: 3 } });

    const freshRemoval = await server.inject({
      method: 'POST',
      url: '/api/v1/internal/discord/role-sync',
      headers: roleSyncHeaders('access:role-sync:fresh-removal'),
      payload: { ...syncPayload({ discordUserId: targetL3.discordUserId, observedRoleIds: [], sourceEventId: 'fresh-removal' }), observedAt: now.toISOString() }
    });
    expect(freshRemoval.json()).toMatchObject({ data: { effectiveLevel: null, status: 'ACCESS_REVOKED', permissionsVersion: 4 } });

    const staleRestore = await server.inject({
      method: 'POST',
      url: '/api/v1/internal/discord/role-sync',
      headers: roleSyncHeaders('access:role-sync:stale-restore'),
      payload: { ...syncPayload({ discordUserId: targetL3.discordUserId, observedRoleIds: [roles.L3_OPERATIONS], sourceEventId: 'stale-restore' }), observedAt: new Date(now.getTime() - 60_000).toISOString() }
    });
    expect(staleRestore.statusCode).toBe(200);
    expect(staleRestore.json()).toMatchObject({ data: { effectiveLevel: null, status: 'NO_CHANGE', permissionsVersion: 4 } });
  });

  test('revokes all target sessions through the explicit session revocation API', async () => {
    const { server, authStore } = fixture();
    const firstSession = await authStore.createSession(sessionStaff(targetL2), now);
    const secondSession = await authStore.createSession(sessionStaff(targetL2), now);
    await authStore.createSession(sessionStaff(targetL2), new Date(now.getTime() - 9 * 60 * 60_000));
    const revoked = await server.inject({
      method: 'POST',
      url: `/api/v1/admin/staff/${targetL2.staffId}/revoke-sessions`,
      headers: adminHeaders(ownerA, 'access:sessions:revoke-all', { 'x-test-step-up': 'valid' }),
      payload: {
        reasonCode: 'ACCESS_CHANGE',
        note: 'End both sessions after the access review.'
      }
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({
      data: {
        staffId: targetL2.staffId,
        revokedSessionCount: 2,
        revokedAt: now.toISOString()
      }
    });

    for (const session of [firstSession, secondSession]) {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/admin/me/capabilities',
        headers: sessionHeaders(session)
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: 'SESSION_REVOKED' } });
    }
  });
});
