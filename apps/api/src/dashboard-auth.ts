import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { StaffDirectoryQueryClient } from './security.js';
import {
  buildTotpProvisioningUri,
  decryptSecret,
  encryptSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  verifyTotp
} from './mfa.js';
import {
  registerSecureReadRoute,
  registerSecureWriteRoute,
  type DashboardSessionResolver,
  type StaffAccount,
  type StaffDirectory,
  type StaffLevel
} from './security.js';
import type { PolicyReader } from './operations.js';
import { InMemoryDashboardMetricsStore, type DashboardMetricsStore } from './dashboard-metrics.js';
import { resolveStaffPolicy } from './authorization-policy.js';

export interface DiscordOAuthProvider {
  getAuthorizationUrl(input: { state: string }): string;
  exchangeCode(code: string): Promise<{ discordUserId: string }>;
}

export interface DashboardAuthStore extends DashboardSessionResolver {
  createOAuthState(now?: Date): string;
  consumeOAuthState(state: string, now?: Date): boolean;
  createSession(staff: StaffAccount, now?: Date):
    | { sessionToken: string; csrfToken: string }
    | Promise<{ sessionToken: string; csrfToken: string }>;
  revoke(sessionToken: string): void | Promise<void>;
  revokeStaffSessions(staffId: string, now?: Date): number | Promise<number>;
  beginMfaEnrollment(input: { staffId: string; accountName: string; now?: Date }): MfaEnrollment | Promise<MfaEnrollment>;
  verifyMfaEnrollment(input: { staffId: string; enrollmentId: string; proof: string; now?: Date }): MfaActivation | Promise<MfaActivation>;
  beginStepUp(input: { staffId: string; sessionToken: string; now?: Date }): StepUpChallenge | Promise<StepUpChallenge>;
  completeStepUp(input: { staffId: string; sessionToken: string; challengeId: string; method: 'TOTP' | 'RECOVERY_CODE'; proof: string; now?: Date }): StepUpState | Promise<StepUpState>;
  getStepUpValidUntil(sessionToken: string, now?: Date): Date | null | Promise<Date | null>;
  isMfaEnrolled(staffId: string): boolean | Promise<boolean>;
}

export interface MfaEnrollment { enrollmentId: string; method: 'TOTP'; provisioningUri: string; expiresAt: Date }
export interface MfaActivation { method: 'TOTP'; enrolled: true; verifiedAt: Date; recoveryCodes: string[] }
export interface StepUpChallenge { challengeId: string; method: 'TOTP' | 'RECOVERY_CODE'; expiresAt: Date }
export interface StepUpState { verifiedAt: Date; validUntil: Date }

export class DashboardAuthConflictError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

export class DiscordHttpOAuthProvider implements DiscordOAuthProvider {
  constructor(private readonly options: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    fetch?: typeof fetch;
  }) {}

  getAuthorizationUrl({ state }: { state: string }): string {
    const url = new URL('https://discord.com/oauth2/authorize');
    url.search = new URLSearchParams({
      client_id: this.options.clientId,
      response_type: 'code',
      redirect_uri: this.options.redirectUri,
      scope: 'identify',
      state,
      prompt: 'none'
    }).toString();
    return url.toString();
  }

  async exchangeCode(code: string): Promise<{ discordUserId: string }> {
    const request = this.options.fetch ?? fetch;
    const tokenResponse = await request('https://discord.com/api/v10/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.options.redirectUri
      })
    });
    if (!tokenResponse.ok) throw new Error('Discord token exchange failed.');
    const token = await tokenResponse.json() as { access_token?: unknown };
    if (typeof token.access_token !== 'string') throw new Error('Discord access token is missing.');
    const userResponse = await request('https://discord.com/api/v10/users/@me', {
      headers: { authorization: `Bearer ${token.access_token}` }
    });
    if (!userResponse.ok) throw new Error('Discord user lookup failed.');
    const user = await userResponse.json() as { id?: unknown };
    if (typeof user.id !== 'string') throw new Error('Discord user id is missing.');
    return { discordUserId: user.id };
  }
}

interface StoredSession {
  sessionHash: string;
  staff: StaffAccount;
  permissionsVersion: number;
  csrfToken: string;
  expiresAt: Date;
  revokedAt: Date | null;
  stepUpAt: Date | null;
}

interface StoredMfaEnrollment { staffId: string; secretCiphertext: string; expiresAt: Date; verifiedAt: Date | null; failedAttempts: number }
interface StoredMfaCredential { secretCiphertext: string; recoveryCodeHashes: Set<string>; verifiedAt: Date }
interface StoredStepUpChallenge { staffId: string; sessionHash: string; method: 'TOTP' | 'RECOVERY_CODE'; expiresAt: Date; consumedAt: Date | null; failedAttempts: number }

export class InMemoryDashboardAuthStore implements DashboardAuthStore {
  private readonly oauthStates = new Map<string, Date>();
  private readonly sessions = new Map<string, StoredSession>();
  private readonly currentPermissionsVersions = new Map<string, number>();
  private readonly enrollments = new Map<string, StoredMfaEnrollment>();
  private readonly credentials = new Map<string, StoredMfaCredential>();
  private readonly challenges = new Map<string, StoredStepUpChallenge>();

  constructor(private readonly encryptionKey = 'development-only-mfa-encryption-key', private readonly policyReader?: PolicyReader) {}

  createOAuthState(now = new Date()): string {
    const state = randomToken();
    this.oauthStates.set(hash(state), new Date(now.getTime() + 10 * 60_000));
    return state;
  }

  consumeOAuthState(state: string, now = new Date()): boolean {
    const key = hash(state);
    const expiresAt = this.oauthStates.get(key);
    this.oauthStates.delete(key);
    return Boolean(expiresAt && expiresAt > now);
  }

  createSession(staff: StaffAccount, now = new Date()) {
    const sessionToken = randomToken();
    const csrfToken = randomToken();
    const sessionHash = hash(sessionToken);
    this.currentPermissionsVersions.set(staff.staffId, staff.permissionsVersion);
    this.sessions.set(sessionHash, {
      sessionHash,
      staff: { ...staff },
      permissionsVersion: staff.permissionsVersion,
      csrfToken,
      expiresAt: new Date(now.getTime() + 8 * 60 * 60_000),
      revokedAt: null,
      stepUpAt: null
    });
    return { sessionToken, csrfToken };
  }

  resolve(sessionToken: string, now = new Date()) {
    const session = this.sessions.get(hash(sessionToken));
    if (!session) return { ok: false as const, reason: 'AUTH_REQUIRED' as const };
    const currentVersion = this.currentPermissionsVersions.get(session.staff.staffId);
    if (
      session.revokedAt ||
      session.expiresAt <= now ||
      currentVersion !== session.permissionsVersion ||
      session.staff.status !== 'ACTIVE'
    ) {
      session.revokedAt ??= now;
      return { ok: false as const, reason: 'SESSION_REVOKED' as const };
    }
    const requiresMfa = session.staff.level === 'L3_OPERATIONS' || session.staff.level === 'L4_ADMIN_OWNER';
    return {
      ok: true as const,
      staff: { ...session.staff, level: requiresMfa && !this.credentials.has(session.staff.staffId) ? 'L1_SUPPORT' as const : session.staff.level },
      csrfToken: session.csrfToken
    };
  }

  verifyCsrf(sessionToken: string, csrfToken: string): boolean {
    const session = this.sessions.get(hash(sessionToken));
    if (!session || session.revokedAt) return false;
    return safeEqual(session.csrfToken, csrfToken);
  }

  revoke(sessionToken: string): void {
    const session = this.sessions.get(hash(sessionToken));
    if (session) session.revokedAt = new Date();
  }

  revokeStaffSessions(staffId: string, now = new Date()): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.staff.staffId === staffId && !session.revokedAt && session.expiresAt > now) { session.revokedAt = now; count += 1; }
    }
    return count;
  }

  setCurrentPermissionsVersion(staffId: string, version: number): void {
    this.currentPermissionsVersions.set(staffId, version);
  }

  beginMfaEnrollment({ staffId, accountName, now = new Date() }: { staffId: string; accountName: string; now?: Date }): MfaEnrollment {
    if (this.credentials.has(staffId)) throw new DashboardAuthConflictError('MFA_ALREADY_ENROLLED', 'MFA is already enrolled.');
    const enrollmentId = crypto.randomUUID();
    const secret = generateTotpSecret();
    const expiresAt = new Date(now.getTime() + 10 * 60_000);
    this.enrollments.set(enrollmentId, { staffId, secretCiphertext: encryptSecret(secret, this.encryptionKey), expiresAt, verifiedAt: null, failedAttempts: 0 });
    return { enrollmentId, method: 'TOTP', provisioningUri: buildTotpProvisioningUri({ secret, accountName, issuer: 'Blackcat Companion' }), expiresAt };
  }

  verifyMfaEnrollment({ staffId, enrollmentId, proof, now = new Date() }: { staffId: string; enrollmentId: string; proof: string; now?: Date }): MfaActivation {
    const enrollment = this.enrollments.get(enrollmentId);
    if (!enrollment || enrollment.staffId !== staffId) throw new DashboardAuthConflictError('MFA_ENROLLMENT_NOT_FOUND', 'The MFA enrollment does not belong to this staff account.');
    if (enrollment.verifiedAt) throw new DashboardAuthConflictError('MFA_ENROLLMENT_CONSUMED', 'The MFA enrollment was already verified.');
    if (enrollment.expiresAt <= now) throw new DashboardAuthConflictError('MFA_ENROLLMENT_EXPIRED', 'The MFA enrollment expired.');
    if (enrollment.failedAttempts >= 5) throw new DashboardAuthConflictError('MFA_ATTEMPTS_EXCEEDED', 'Too many invalid MFA attempts. Start a new enrollment.');
    const secret = decryptSecret(enrollment.secretCiphertext, this.encryptionKey);
    if (!verifyTotp(proof, secret, now)) {
      enrollment.failedAttempts += 1;
      throw new DashboardAuthConflictError(enrollment.failedAttempts >= 5 ? 'MFA_ATTEMPTS_EXCEEDED' : 'MFA_PROOF_INVALID', 'The MFA proof is invalid.');
    }
    const recoveryCodes = generateRecoveryCodes();
    enrollment.verifiedAt = now;
    this.credentials.set(staffId, {
      secretCiphertext: enrollment.secretCiphertext,
      recoveryCodeHashes: new Set(recoveryCodes.map((code) => hashRecoveryCode(code, this.encryptionKey))),
      verifiedAt: now
    });
    return { method: 'TOTP', enrolled: true, verifiedAt: now, recoveryCodes };
  }

  beginStepUp({ staffId, sessionToken, now = new Date() }: { staffId: string; sessionToken: string; now?: Date }): StepUpChallenge {
    if (!this.credentials.has(staffId)) throw new DashboardAuthConflictError('MFA_NOT_ENROLLED', 'MFA enrollment is required.');
    const sessionHash = hash(sessionToken);
    const session = this.sessions.get(sessionHash);
    if (!session || session.staff.staffId !== staffId || session.revokedAt || session.expiresAt <= now) {
      throw new DashboardAuthConflictError('SESSION_REVOKED', 'The staff session is no longer active.');
    }
    const challengeId = crypto.randomUUID();
    const expiresAt = new Date(now.getTime() + 5 * 60_000);
    this.challenges.set(challengeId, { staffId, sessionHash, method: 'TOTP', expiresAt, consumedAt: null, failedAttempts: 0 });
    return { challengeId, method: 'TOTP', expiresAt };
  }

  async completeStepUp({ staffId, sessionToken, challengeId, method, proof, now = new Date() }: { staffId: string; sessionToken: string; challengeId: string; method: 'TOTP' | 'RECOVERY_CODE'; proof: string; now?: Date }): Promise<StepUpState> {
    const challenge = this.challenges.get(challengeId);
    const sessionHash = hash(sessionToken);
    if (!challenge || challenge.staffId !== staffId || challenge.sessionHash !== sessionHash) throw new DashboardAuthConflictError('STEP_UP_CHALLENGE_NOT_FOUND', 'The challenge does not belong to this session.');
    if (challenge.consumedAt) throw new DashboardAuthConflictError('STEP_UP_CHALLENGE_CONSUMED', 'The challenge was already used.');
    if (challenge.expiresAt <= now) throw new DashboardAuthConflictError('STEP_UP_CHALLENGE_EXPIRED', 'The challenge expired.');
    if (challenge.failedAttempts >= 5) throw new DashboardAuthConflictError('MFA_ATTEMPTS_EXCEEDED', 'Too many invalid MFA attempts. Start a new challenge.');
    const credential = this.credentials.get(staffId);
    if (!credential) throw new DashboardAuthConflictError('MFA_NOT_ENROLLED', 'MFA enrollment is required.');
    let valid = false;
    if (method === 'TOTP') valid = verifyTotp(proof, decryptSecret(credential.secretCiphertext, this.encryptionKey), now);
    else {
      const proofHash = hashRecoveryCode(proof, this.encryptionKey);
      valid = credential.recoveryCodeHashes.delete(proofHash);
    }
    if (!valid) {
      challenge.failedAttempts += 1;
      if (challenge.failedAttempts >= 5) challenge.consumedAt = now;
      throw new DashboardAuthConflictError(challenge.failedAttempts >= 5 ? 'MFA_ATTEMPTS_EXCEEDED' : 'MFA_PROOF_INVALID', 'The MFA proof is invalid.');
    }
    const session = this.sessions.get(sessionHash);
    if (!session || session.revokedAt || session.expiresAt <= now) throw new DashboardAuthConflictError('SESSION_REVOKED', 'The staff session is no longer active.');
    challenge.consumedAt = now;
    session.stepUpAt = now;
    const validityMinutes = await this.policyReader?.getPolicyInteger('STEP_UP_VALIDITY_MINUTES', 15) ?? 15;
    return { verifiedAt: now, validUntil: new Date(now.getTime() + validityMinutes * 60_000) };
  }

  async getStepUpValidUntil(sessionToken: string, now = new Date()): Promise<Date | null> {
    const session = this.sessions.get(hash(sessionToken));
    if (!session?.stepUpAt || session.revokedAt || session.expiresAt <= now) return null;
    const validityMinutes = await this.policyReader?.getPolicyInteger('STEP_UP_VALIDITY_MINUTES', 15) ?? 15;
    const validUntil = new Date(session.stepUpAt.getTime() + validityMinutes * 60_000);
    return validUntil > now ? validUntil : null;
  }

  async verifyRecentStepUp(sessionToken: string, now = new Date()): Promise<boolean> {
    return (await this.getStepUpValidUntil(sessionToken, now)) !== null;
  }

  isMfaEnrolled(staffId: string): boolean { return this.credentials.has(staffId); }
}

export class PostgresDashboardAuthStore implements DashboardAuthStore {
  private readonly oauthStates = new Map<string, Date>();

  constructor(private readonly options: { client: StaffDirectoryQueryClient; csrfSecret: string; mfaEncryptionKey: string; policyReader?: PolicyReader }) {}

  private get mfaEncryptionKey(): string { return this.options.mfaEncryptionKey; }

  createOAuthState(now = new Date()): string {
    const state = randomToken();
    this.oauthStates.set(hash(state), new Date(now.getTime() + 10 * 60_000));
    return state;
  }

  consumeOAuthState(state: string, now = new Date()): boolean {
    const key = hash(state);
    const expiresAt = this.oauthStates.get(key);
    this.oauthStates.delete(key);
    return Boolean(expiresAt && expiresAt > now);
  }

  async createSession(staff: StaffAccount, now = new Date()) {
    const sessionToken = randomToken();
    const csrfToken = csrfFor(sessionToken, this.options.csrfSecret);
    await this.options.client.query(
      `INSERT INTO staff_sessions
        (id, staff_account_id, session_hash, permissions_version, expires_at, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5::timestamptz, $6::timestamptz, $6::timestamptz)`,
      [crypto.randomUUID(), staff.staffId, hash(sessionToken), staff.permissionsVersion, new Date(now.getTime() + 8 * 60 * 60_000).toISOString(), now.toISOString()]
    );
    return { sessionToken, csrfToken };
  }

  async resolve(sessionToken: string, now = new Date()) {
    const result = await this.options.client.query<{
      session_permissions_version: number;
      expires_at: Date | string;
      revoked_at: Date | string | null;
      staff_id: string;
      user_id: string;
      level: StaffLevel;
      staff_permissions_version: number;
      status: StaffAccount['status'];
      mfa_enrolled: boolean;
    }>(
      `SELECT session.permissions_version AS session_permissions_version,
              session.expires_at,
              session.revoked_at,
              staff.id AS staff_id,
              staff.user_id,
              staff.level,
              staff.permissions_version AS staff_permissions_version,
              staff.status,
              staff.mfa_enrolled
         FROM staff_sessions AS session
         JOIN staff_accounts AS staff ON staff.id = session.staff_account_id
        WHERE session.session_hash = $1
        LIMIT 1`,
      [hash(sessionToken)]
    );
    const row = result.rows[0];
    if (!row) return { ok: false as const, reason: 'AUTH_REQUIRED' as const };
    if (
      row.revoked_at ||
      new Date(row.expires_at) <= now ||
      row.session_permissions_version !== row.staff_permissions_version ||
      row.status !== 'ACTIVE'
    ) {
      await this.options.client.query(
        'UPDATE staff_sessions SET revoked_at = COALESCE(revoked_at, $2::timestamptz), updated_at = $2::timestamptz WHERE session_hash = $1',
        [hash(sessionToken), now.toISOString()]
      );
      return { ok: false as const, reason: 'SESSION_REVOKED' as const };
    }
    return {
      ok: true as const,
      staff: {
        staffId: row.staff_id,
        userId: row.user_id,
        level: (row.level === 'L3_OPERATIONS' || row.level === 'L4_ADMIN_OWNER') && !row.mfa_enrolled ? 'L1_SUPPORT' : row.level,
        permissionsVersion: row.staff_permissions_version,
        status: row.status
      },
      csrfToken: csrfFor(sessionToken, this.options.csrfSecret)
    };
  }

  verifyCsrf(sessionToken: string, csrfToken: string): boolean {
    return safeEqual(csrfFor(sessionToken, this.options.csrfSecret), csrfToken);
  }

  async revoke(sessionToken: string): Promise<void> {
    await this.options.client.query(
      'UPDATE staff_sessions SET revoked_at = COALESCE(revoked_at, now()), updated_at = now() WHERE session_hash = $1',
      [hash(sessionToken)]
    );
  }

  async revokeStaffSessions(staffId: string, now = new Date()): Promise<number> {
    const result = await this.options.client.query<{ id: string }>(
      `UPDATE staff_sessions SET revoked_at = $2::timestamptz, updated_at = $2::timestamptz
        WHERE staff_account_id = $1::uuid AND revoked_at IS NULL AND expires_at > $2::timestamptz RETURNING id`,
      [staffId, now.toISOString()]
    );
    return result.rows.length;
  }

  async beginMfaEnrollment({ staffId, accountName, now = new Date() }: { staffId: string; accountName: string; now?: Date }): Promise<MfaEnrollment> {
    const secret = generateTotpSecret();
    const enrollmentId = crypto.randomUUID();
    const expiresAt = new Date(now.getTime() + 10 * 60_000);
    try {
      const result = await this.options.client.query<{ id: string }>(
        `INSERT INTO staff_mfa_enrollments
          (id, staff_account_id, method, secret_ciphertext, expires_at, created_at)
         SELECT $1::uuid, staff.id, 'TOTP', $3, $4::timestamptz, $5::timestamptz
           FROM staff_accounts AS staff
          WHERE staff.id = $2::uuid
            AND staff.status = 'ACTIVE'
            AND staff.mfa_enrolled = false
            AND NOT EXISTS (SELECT 1 FROM staff_mfa_credentials AS credential WHERE credential.staff_account_id = staff.id)
         RETURNING id`,
        [enrollmentId, staffId, encryptSecret(secret, this.mfaEncryptionKey), expiresAt.toISOString(), now.toISOString()]
      );
      if (!result.rows[0]) throw new DashboardAuthConflictError('MFA_ALREADY_ENROLLED', 'MFA is already enrolled or the staff account is inactive.');
    } catch (error) {
      if (error instanceof DashboardAuthConflictError) throw error;
      throw new DashboardAuthConflictError('MFA_ENROLLMENT_CONFLICT', 'MFA enrollment could not be started.');
    }
    return { enrollmentId, method: 'TOTP', provisioningUri: buildTotpProvisioningUri({ secret, accountName, issuer: 'Blackcat Companion' }), expiresAt };
  }

  async verifyMfaEnrollment({ staffId, enrollmentId, proof, now = new Date() }: { staffId: string; enrollmentId: string; proof: string; now?: Date }): Promise<MfaActivation> {
    const found = await this.options.client.query<{ secret_ciphertext: string; expires_at: Date | string; verified_at: Date | string | null; failed_attempts: number }>(
      `SELECT secret_ciphertext, expires_at, verified_at, failed_attempts
         FROM staff_mfa_enrollments
        WHERE id = $1::uuid AND staff_account_id = $2::uuid
        LIMIT 1`,
      [enrollmentId, staffId]
    );
    const enrollment = found.rows[0];
    if (!enrollment) throw new DashboardAuthConflictError('MFA_ENROLLMENT_NOT_FOUND', 'The MFA enrollment does not belong to this staff account.');
    if (enrollment.verified_at) throw new DashboardAuthConflictError('MFA_ENROLLMENT_CONSUMED', 'The MFA enrollment was already verified.');
    if (new Date(enrollment.expires_at) <= now) throw new DashboardAuthConflictError('MFA_ENROLLMENT_EXPIRED', 'The MFA enrollment expired.');
    if (enrollment.failed_attempts >= 5) throw new DashboardAuthConflictError('MFA_ATTEMPTS_EXCEEDED', 'Too many invalid MFA attempts. Start a new enrollment.');
    if (!verifyTotp(proof, decryptSecret(enrollment.secret_ciphertext, this.mfaEncryptionKey), now)) {
      const attempts = await this.options.client.query<{ failed_attempts: number }>(
        `UPDATE staff_mfa_enrollments SET failed_attempts = failed_attempts + 1
          WHERE id = $1::uuid AND staff_account_id = $2::uuid AND verified_at IS NULL AND failed_attempts < 5
          RETURNING failed_attempts`, [enrollmentId, staffId]
      );
      throw new DashboardAuthConflictError((attempts.rows[0]?.failed_attempts ?? 5) >= 5 ? 'MFA_ATTEMPTS_EXCEEDED' : 'MFA_PROOF_INVALID', 'The MFA proof is invalid.');
    }
    const recoveryCodes = generateRecoveryCodes();
    const credentialId = crypto.randomUUID();
    const codeIds = recoveryCodes.map(() => crypto.randomUUID());
    const codeHashes = recoveryCodes.map((code) => hashRecoveryCode(code, this.mfaEncryptionKey));
    const activated = await this.options.client.query<{ id: string }>(
      `WITH verified AS (
         UPDATE staff_mfa_enrollments
            SET verified_at = $3::timestamptz
          WHERE id = $1::uuid AND staff_account_id = $2::uuid
            AND verified_at IS NULL AND expires_at > $3::timestamptz
          RETURNING secret_ciphertext
       ), credential AS (
         INSERT INTO staff_mfa_credentials
           (id, staff_account_id, method, secret_ciphertext, verified_at, created_at, updated_at)
         SELECT $4::uuid, $2::uuid, 'TOTP', secret_ciphertext, $3::timestamptz, $3::timestamptz, $3::timestamptz FROM verified
         ON CONFLICT (staff_account_id) DO NOTHING
         RETURNING id
       ), codes AS (
         INSERT INTO staff_mfa_recovery_codes (id, credential_id, code_hash, created_at)
         SELECT input.id::uuid, credential.id, input.code_hash, $3::timestamptz
           FROM credential
           CROSS JOIN unnest($5::text[], $6::text[]) AS input(id, code_hash)
       )
       UPDATE staff_accounts SET mfa_enrolled = true, updated_at = $3::timestamptz
        WHERE id = $2::uuid AND EXISTS (SELECT 1 FROM credential)
       RETURNING id`,
      [enrollmentId, staffId, now.toISOString(), credentialId, codeIds, codeHashes]
    );
    if (!activated.rows[0]) throw new DashboardAuthConflictError('MFA_ENROLLMENT_CONFLICT', 'The MFA enrollment changed before activation.');
    return { method: 'TOTP', enrolled: true, verifiedAt: now, recoveryCodes };
  }

  async beginStepUp({ staffId, sessionToken, now = new Date() }: { staffId: string; sessionToken: string; now?: Date }): Promise<StepUpChallenge> {
    const challengeId = crypto.randomUUID();
    const expiresAt = new Date(now.getTime() + 5 * 60_000);
    const result = await this.options.client.query<{ id: string }>(
      `INSERT INTO staff_step_up_challenges
        (id, staff_account_id, staff_session_id, method, expires_at, created_at)
       SELECT $1::uuid, session.staff_account_id, session.id, 'TOTP', $4::timestamptz, $5::timestamptz
         FROM staff_sessions AS session
         JOIN staff_accounts AS staff ON staff.id = session.staff_account_id
        WHERE session.session_hash = $2 AND session.staff_account_id = $3::uuid
          AND session.revoked_at IS NULL AND session.expires_at > $5::timestamptz
          AND staff.status = 'ACTIVE' AND staff.mfa_enrolled = true
          AND EXISTS (SELECT 1 FROM staff_mfa_credentials AS credential WHERE credential.staff_account_id = staff.id)
       RETURNING id`,
      [challengeId, hash(sessionToken), staffId, expiresAt.toISOString(), now.toISOString()]
    );
    if (!result.rows[0]) throw new DashboardAuthConflictError('MFA_NOT_ENROLLED', 'MFA enrollment and an active session are required.');
    return { challengeId, method: 'TOTP', expiresAt };
  }

  async completeStepUp({ staffId, sessionToken, challengeId, method, proof, now = new Date() }: { staffId: string; sessionToken: string; challengeId: string; method: 'TOTP' | 'RECOVERY_CODE'; proof: string; now?: Date }): Promise<StepUpState> {
    const found = await this.options.client.query<{ secret_ciphertext: string; expires_at: Date | string; consumed_at: Date | string | null; failed_attempts: number }>(
      `SELECT credential.secret_ciphertext, challenge.expires_at, challenge.consumed_at, challenge.failed_attempts
         FROM staff_step_up_challenges AS challenge
         JOIN staff_sessions AS session ON session.id = challenge.staff_session_id
         JOIN staff_mfa_credentials AS credential ON credential.staff_account_id = challenge.staff_account_id
        WHERE challenge.id = $1::uuid AND challenge.staff_account_id = $2::uuid
          AND session.session_hash = $3
        LIMIT 1`,
      [challengeId, staffId, hash(sessionToken)]
    );
    const challenge = found.rows[0];
    if (!challenge) throw new DashboardAuthConflictError('STEP_UP_CHALLENGE_NOT_FOUND', 'The challenge does not belong to this session.');
    if (challenge.consumed_at) throw new DashboardAuthConflictError('STEP_UP_CHALLENGE_CONSUMED', 'The challenge was already used.');
    if (new Date(challenge.expires_at) <= now) throw new DashboardAuthConflictError('STEP_UP_CHALLENGE_EXPIRED', 'The challenge expired.');
    if (challenge.failed_attempts >= 5) throw new DashboardAuthConflictError('MFA_ATTEMPTS_EXCEEDED', 'Too many invalid MFA attempts. Start a new challenge.');
    const codeHash = method === 'RECOVERY_CODE' ? hashRecoveryCode(proof, this.mfaEncryptionKey) : null;
    if (method === 'TOTP' && !verifyTotp(proof, decryptSecret(challenge.secret_ciphertext, this.mfaEncryptionKey), now)) {
      await this.recordFailedStepUpAttempt(challengeId, staffId, now);
    }
    const completed = await this.options.client.query<{ step_up_at: Date | string }>(
      `WITH recovery AS (
         UPDATE staff_mfa_recovery_codes AS code
            SET consumed_at = $4::timestamptz
           FROM staff_mfa_credentials AS credential
          WHERE $5::text = 'RECOVERY_CODE' AND code.credential_id = credential.id
            AND credential.staff_account_id = $2::uuid AND code.code_hash = $6 AND code.consumed_at IS NULL
          RETURNING code.id
       ), consumed AS (
         UPDATE staff_step_up_challenges
            SET consumed_at = $4::timestamptz
          WHERE id = $1::uuid AND staff_account_id = $2::uuid
            AND consumed_at IS NULL AND expires_at > $4::timestamptz
            AND ($5::text = 'TOTP' OR EXISTS (SELECT 1 FROM recovery))
          RETURNING staff_session_id
       )
       UPDATE staff_sessions AS session
          SET step_up_at = $4::timestamptz, updated_at = $4::timestamptz
         FROM consumed
        WHERE session.id = consumed.staff_session_id AND session.session_hash = $3
          AND session.revoked_at IS NULL AND session.expires_at > $4::timestamptz
       RETURNING session.step_up_at`,
      [challengeId, staffId, hash(sessionToken), now.toISOString(), method, codeHash]
    );
    if (!completed.rows[0]) {
      if (method === 'RECOVERY_CODE') await this.recordFailedStepUpAttempt(challengeId, staffId, now);
      throw new DashboardAuthConflictError(method === 'RECOVERY_CODE' ? 'MFA_PROOF_INVALID' : 'STEP_UP_CHALLENGE_CONFLICT', 'The proof or challenge is no longer valid.');
    }
    const validityMinutes = await this.options.policyReader?.getPolicyInteger('STEP_UP_VALIDITY_MINUTES', 15) ?? 15;
    return { verifiedAt: now, validUntil: new Date(now.getTime() + validityMinutes * 60_000) };
  }

  async getStepUpValidUntil(sessionToken: string, now = new Date()): Promise<Date | null> {
    const result = await this.options.client.query<{ step_up_at: Date | string | null }>(
      `SELECT step_up_at FROM staff_sessions
        WHERE session_hash = $1 AND revoked_at IS NULL AND expires_at > $2::timestamptz
        LIMIT 1`,
      [hash(sessionToken), now.toISOString()]
    );
    const stepUpAt = result.rows[0]?.step_up_at;
    if (!stepUpAt) return null;
    const validityMinutes = await this.options.policyReader?.getPolicyInteger('STEP_UP_VALIDITY_MINUTES', 15) ?? 15;
    const validUntil = new Date(new Date(stepUpAt).getTime() + validityMinutes * 60_000);
    return validUntil > now ? validUntil : null;
  }

  async verifyRecentStepUp(sessionToken: string, now = new Date()): Promise<boolean> {
    return (await this.getStepUpValidUntil(sessionToken, now)) !== null;
  }

  async isMfaEnrolled(staffId: string): Promise<boolean> {
    const result = await this.options.client.query<{ enrolled: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM staff_mfa_credentials WHERE staff_account_id = $1::uuid) AS enrolled',
      [staffId]
    );
    return result.rows[0]?.enrolled === true;
  }

  private async recordFailedStepUpAttempt(challengeId: string, staffId: string, now: Date): Promise<never> {
    const result = await this.options.client.query<{ failed_attempts: number }>(
      `UPDATE staff_step_up_challenges
          SET failed_attempts = failed_attempts + 1,
              consumed_at = CASE WHEN failed_attempts + 1 >= 5 THEN $3::timestamptz ELSE consumed_at END
        WHERE id = $1::uuid AND staff_account_id = $2::uuid AND consumed_at IS NULL AND failed_attempts < 5
        RETURNING failed_attempts`,
      [challengeId, staffId, now.toISOString()]
    );
    throw new DashboardAuthConflictError((result.rows[0]?.failed_attempts ?? 5) >= 5 ? 'MFA_ATTEMPTS_EXCEEDED' : 'MFA_PROOF_INVALID', 'The MFA proof is invalid.');
  }
}

export interface DashboardAuthOptions {
  store: DashboardAuthStore;
  oauth: DiscordOAuthProvider;
  staffDirectory: StaffDirectory;
  guildId: string;
  dashboardUrl: string;
  secureCookies?: boolean;
  now?: () => Date;
  policyReader?: PolicyReader;
  metricsStore?: DashboardMetricsStore;
  metricsTimeZone?: 'Asia/Shanghai';
  metricsCurrency?: 'CNY';
}

export function registerDashboardAuthRoutes(server: FastifyInstance, options: DashboardAuthOptions): void {
  const now = options.now ?? (() => new Date());
  const secureCookies = options.secureCookies ?? true;

  server.get('/api/v1/auth/discord', async (_request, reply) => {
    const state = options.store.createOAuthState(now());
    reply.header('set-cookie', serializeCookie('p0_oauth_state', state, { httpOnly: true, maxAge: 600, secure: secureCookies }));
    return reply.redirect(options.oauth.getAuthorizationUrl({ state }));
  });

  server.get('/api/v1/auth/discord/callback', async (request, reply) => {
    const query = request.query as { code?: unknown; state?: unknown };
    const cookies = parseCookies(request);
    if (
      typeof query.code !== 'string' ||
      typeof query.state !== 'string' ||
      !cookies.p0_oauth_state ||
      !safeEqual(query.state, cookies.p0_oauth_state) ||
      !options.store.consumeOAuthState(query.state, now())
    ) {
      return authError(reply, 401, 'OAUTH_STATE_INVALID', 'The OAuth state is invalid or expired.');
    }

    let discordUserId: string;
    try {
      ({ discordUserId } = await options.oauth.exchangeCode(query.code));
    } catch {
      return authError(reply, 401, 'OAUTH_EXCHANGE_FAILED', 'Discord authorization could not be completed.');
    }
    const staff = await options.staffDirectory.resolveByDiscord({ discordUserId, guildId: options.guildId });
    if (!staff || staff.status !== 'ACTIVE') {
      return authError(reply, 403, 'STAFF_ACCOUNT_REQUIRED', 'An active staff account is required.');
    }
    const session = await options.store.createSession(staff, now());
    reply.header('set-cookie', [
      serializeCookie('p0_session', session.sessionToken, { httpOnly: true, maxAge: 28_800, secure: secureCookies }),
      serializeCookie('p0_csrf', session.csrfToken, { httpOnly: false, maxAge: 28_800, secure: secureCookies }),
      serializeCookie('p0_oauth_state', '', { httpOnly: true, maxAge: 0, secure: secureCookies })
    ]);
    return reply.redirect(new URL('/', options.dashboardUrl).toString());
  });

  server.post('/api/v1/auth/logout', async (request, reply) => {
    const cookies = parseCookies(request);
    const sessionToken = cookies.p0_session;
    const csrfHeader = request.headers['x-csrf-token'];
    if (!sessionToken || !cookies.p0_csrf || csrfHeader !== cookies.p0_csrf || !(await options.store.verifyCsrf(sessionToken, cookies.p0_csrf))) {
      return authError(reply, 403, 'CSRF_REQUIRED', 'A valid CSRF token is required.');
    }
    if (sessionToken) await options.store.revoke(sessionToken);
    reply.header('set-cookie', [
      serializeCookie('p0_session', '', { httpOnly: true, maxAge: 0, secure: secureCookies }),
      serializeCookie('p0_csrf', '', { httpOnly: false, maxAge: 0, secure: secureCookies })
    ]);
    reply.code(204).send();
  });

  if (!server.securityOptions) throw new Error('Dashboard auth routes require security options.');
  registerSecureReadRoute(server, server.securityOptions, {
    method: 'GET',
    url: '/api/v1/admin/me/capabilities',
    permission: 'staff.session.active',
    action: 'GET_CURRENT_STAFF_CAPABILITIES',
    targetType: 'staff_session',
    acceptedSources: ['DASHBOARD', 'DISCORD_BOT'],
    handler: (request, actor) => buildCapabilities(
      actor.actorStaffId!,
      actor.actorLevel!,
      actor.permissionsVersion!,
      options.store,
      parseCookies(request).p0_session,
      now(),
      options.policyReader
    )
  });
  registerSecureWriteRoute(server, server.securityOptions, {
    method: 'POST',
    url: '/api/v1/admin/auth/mfa/enrollment',
    permission: 'mfa.manage_self',
    action: 'ENROLL_MFA',
    targetType: 'staff_mfa_enrollment',
    acceptedSources: ['DASHBOARD'],
    successStatusCode: 201,
    fingerprintBody: (request) => parseExactBody(request, ['method']),
    mapError: mapDashboardAuthError,
    handler: async (request, actor) => {
      const body = parseExactBody(request, ['method']);
      if (body.method !== 'TOTP') throw new DashboardAuthConflictError('VALIDATION_ERROR', 'Only TOTP enrollment is supported.');
      const result = await options.store.beginMfaEnrollment({ staffId: actor.actorStaffId!, accountName: actor.actorStaffId!, now: now() });
      return { ...result, expiresAt: result.expiresAt.toISOString() };
    }
  });
  registerSecureWriteRoute(server, server.securityOptions, {
    method: 'POST',
    url: '/api/v1/admin/auth/mfa/enrollment/:enrollmentId/verify',
    permission: 'mfa.manage_self',
    action: 'VERIFY_MFA_ENROLLMENT',
    targetType: 'staff_mfa_enrollment',
    targetId: (request) => String((request.params as { enrollmentId?: unknown }).enrollmentId ?? ''),
    acceptedSources: ['DASHBOARD'],
    fingerprintBody: (request) => parseExactBody(request, ['proof']),
    mapError: mapDashboardAuthError,
    handler: async (request, actor) => {
      const body = parseExactBody(request, ['proof']);
      if (typeof body.proof !== 'string' || body.proof.length < 6 || body.proof.length > 100) throw new DashboardAuthConflictError('VALIDATION_ERROR', 'A valid MFA proof is required.');
      const enrollmentId = String((request.params as { enrollmentId?: unknown }).enrollmentId ?? '');
      const result = await options.store.verifyMfaEnrollment({ staffId: actor.actorStaffId!, enrollmentId, proof: body.proof, now: now() });
      return { ...result, verifiedAt: result.verifiedAt.toISOString() };
    }
  });
  registerSecureWriteRoute(server, server.securityOptions, {
    method: 'POST',
    url: '/api/v1/admin/auth/step-up',
    permission: 'step_up.execute',
    action: 'BEGIN_STEP_UP',
    targetType: 'staff_session',
    acceptedSources: ['DASHBOARD'],
    successStatusCode: 201,
    fingerprintBody: (request) => parseExactBody(request, ['purpose']),
    mapError: mapDashboardAuthError,
    handler: async (request, actor) => {
      const body = parseExactBody(request, ['purpose']);
      if (body.purpose !== 'HIGH_RISK_BUSINESS_ACTION') throw new DashboardAuthConflictError('VALIDATION_ERROR', 'The step-up purpose is invalid.');
      const result = await options.store.beginStepUp({ staffId: actor.actorStaffId!, sessionToken: requireSessionToken(request), now: now() });
      return { ...result, expiresAt: result.expiresAt.toISOString() };
    }
  });
  registerSecureWriteRoute(server, server.securityOptions, {
    method: 'POST',
    url: '/api/v1/admin/auth/step-up/:challengeId/complete',
    permission: 'step_up.execute',
    action: 'COMPLETE_STEP_UP',
    targetType: 'staff_session',
    acceptedSources: ['DASHBOARD'],
    fingerprintBody: (request) => parseExactBody(request, ['method', 'proof']),
    mapError: mapDashboardAuthError,
    handler: async (request, actor) => {
      const body = parseExactBody(request, ['method', 'proof']);
      if ((body.method !== 'TOTP' && body.method !== 'RECOVERY_CODE') || typeof body.proof !== 'string' || body.proof.length < 6 || body.proof.length > 100) {
        throw new DashboardAuthConflictError('VALIDATION_ERROR', 'A supported MFA method and proof are required.');
      }
      const challengeId = String((request.params as { challengeId?: unknown }).challengeId ?? '');
      const result = await options.store.completeStepUp({ staffId: actor.actorStaffId!, sessionToken: requireSessionToken(request), challengeId, method: body.method, proof: body.proof, now: now() });
      return { verifiedAt: result.verifiedAt.toISOString(), validUntil: result.validUntil.toISOString() };
    }
  });
  registerSecureReadRoute(server, server.securityOptions, {
    method: 'GET',
    url: '/api/v1/admin/dashboard/summary',
    permission: 'dashboard.view',
    action: 'GET_DASHBOARD_SUMMARY',
    targetType: 'dashboard',
    acceptedSources: ['DASHBOARD', 'DISCORD_BOT'],
    handler: (_request, actor) => (options.metricsStore ?? new InMemoryDashboardMetricsStore({})).getSummary({
      actorStaffId: actor.actorStaffId!, actorLevel: actor.actorLevel!, guildId: actor.guildId,
      now: now(), timeZone: options.metricsTimeZone ?? 'Asia/Shanghai', currency: options.metricsCurrency ?? 'CNY'
    })
  });
}

export async function buildCapabilities(staffId: string, level: StaffLevel, permissionsVersion: number, store?: DashboardAuthStore, sessionToken?: string, current = new Date(), policyReader?: PolicyReader) {
  const policy = resolveStaffPolicy(level);
  const mfaEnrolled = store ? await store.isMfaEnrolled(staffId) : false;
  const [giftApprovalLimitMinor, refundLimitMinor, l4DirectExecutionFromMinor] = await Promise.all([
    policyReader?.getPolicyInteger('L2_GIFT_APPROVAL_LIMIT_MINOR', 200_000) ?? 200_000,
    policyReader?.getPolicyInteger('L2_REFUND_LIMIT_MINOR', 50_000) ?? 50_000,
    policyReader?.getPolicyInteger('L4_DIRECT_EXECUTION_THRESHOLD_MINOR', 500_000) ?? 500_000
  ]);
  return {
    staffId,
    level,
    scope: policy.scope,
    permissions: policy.permissions,
    thresholds: {
      giftApprovalLimitMinor: level === 'L1_SUPPORT' ? null : giftApprovalLimitMinor,
      refundLimitMinor: level === 'L1_SUPPORT' ? null : refundLimitMinor,
      l4DirectExecutionFromMinor,
      currency: 'CNY'
    },
    mfa: { enrolled: mfaEnrolled, method: mfaEnrolled ? 'TOTP' : null },
    stepUp: {
      requiredForSensitiveActions: level === 'L3_OPERATIONS' || level === 'L4_ADMIN_OWNER',
      validUntil: store && sessionToken ? (await store.getStepUpValidUntil(sessionToken, current))?.toISOString() ?? null : null
    },
    permissionsVersion
  };
}

function parseExactBody(request: FastifyRequest, allowedKeys: string[]): Record<string, unknown> {
  const body = request.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new DashboardAuthConflictError('VALIDATION_ERROR', 'A JSON request body is required.');
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowedKeys.includes(key))) throw new DashboardAuthConflictError('VALIDATION_ERROR', 'The request contains unsupported fields.');
  return record;
}

function requireSessionToken(request: FastifyRequest): string {
  const token = parseCookies(request).p0_session;
  if (!token) throw new DashboardAuthConflictError('AUTH_REQUIRED', 'An active Dashboard session is required.');
  return token;
}

function mapDashboardAuthError(error: unknown) {
  if (!(error instanceof DashboardAuthConflictError)) return null;
  if (error.code === 'VALIDATION_ERROR') return { statusCode: 400, code: error.code, message: error.message };
  if (error.code === 'AUTH_REQUIRED' || error.code === 'SESSION_REVOKED') return { statusCode: 401, code: error.code, message: error.message };
  return { statusCode: 409, code: error.code, message: error.message };
}

function serializeCookie(name: string, value: string, options: { httpOnly: boolean; maxAge: number; secure: boolean }): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${options.maxAge}; SameSite=Lax${options.secure ? '; Secure' : ''}${options.httpOnly ? '; HttpOnly' : ''}`;
}

function parseCookies(request: FastifyRequest): Record<string, string> {
  const header = request.headers.cookie ?? '';
  return Object.fromEntries(header.split(';').map((part) => part.trim().split('=' as const)).filter(([key, value]) => key && value !== undefined).map(([key, value]) => [key, decodeURIComponent(value)]));
}

function authError(reply: FastifyReply, status: number, code: string, message: string) {
  reply.code(status);
  return { requestId: `req_${crypto.randomUUID()}`, error: { code, message, retryable: false, details: [] } };
}

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function csrfFor(sessionToken: string, secret: string): string {
  return createHash('sha256').update(`${secret}:${sessionToken}`).digest('base64url');
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
