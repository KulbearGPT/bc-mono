export type PilotFeature = 'CORE_ORDER' | 'GIFTS' | 'REFERRALS' | 'M6';

export interface DashboardCapabilities {
  permissions: string[];
  enabledFeatures: PilotFeature[];
  businessEnvironment: 'SANDBOX' | 'PRODUCTION';
  displayRole: 'STAFF' | 'OWNER' | null;
}

export interface SandboxFundingAccount {
  userId: string;
  providerBalanceMinor: number;
  reservedMinor: number;
  availableMinor: number;
  currency: 'CNY';
  fetchedAt: string;
  version: number;
}

export interface SandboxTargetBalanceRequest {
  currency: 'CNY';
  targetProviderBalanceMinor: number;
  expectedVersion: number;
  reasonCode: 'SANDBOX_TEST_SETUP';
}

export const SANDBOX_WARNING = 'SANDBOX 测试环境 · 测试余额不代表真实资金';

export function getSandboxBanner(environment: 'SANDBOX' | 'PRODUCTION'): string | null {
  return environment === 'SANDBOX' ? SANDBOX_WARNING : null;
}

export function hasFeature(
  capabilities: Pick<DashboardCapabilities, 'enabledFeatures'>,
  feature: PilotFeature
): boolean {
  return capabilities.enabledFeatures.includes(feature);
}

export function canManageSandboxFunding(capabilities: DashboardCapabilities): boolean {
  return capabilities.businessEnvironment === 'SANDBOX'
    && capabilities.displayRole === 'OWNER'
    && capabilities.permissions.includes('sandbox_funding.manage');
}

export function buildTargetBalanceRequest(
  account: Pick<SandboxFundingAccount, 'currency' | 'version'>,
  targetProviderBalanceMinor: number
): SandboxTargetBalanceRequest {
  if (!Number.isSafeInteger(targetProviderBalanceMinor) || targetProviderBalanceMinor < 0) {
    throw new Error('targetProviderBalanceMinor must be a non-negative safe integer.');
  }
  return {
    currency: account.currency,
    targetProviderBalanceMinor,
    expectedVersion: account.version,
    reasonCode: 'SANDBOX_TEST_SETUP'
  };
}

export interface SandboxFundingClient {
  get(path: string): Promise<Response>;
  post(path: string, body: unknown, idempotencyKey?: string): Promise<Response>;
}

export async function getSandboxFundingAccount(client: Pick<SandboxFundingClient, 'get'>, userId: string): Promise<SandboxFundingAccount> {
  const path = `/api/v1/admin/sandbox-funding/accounts/${encodeURIComponent(requireUserId(userId))}`;
  const response = await client.get(path);
  return readAccountResponse(response);
}

export async function setSandboxTargetBalance(
  client: SandboxFundingClient,
  userId: string,
  account: SandboxFundingAccount,
  targetProviderBalanceMinor: number
): Promise<
  | { kind: 'UPDATED'; account: SandboxFundingAccount }
  | { kind: 'CONFLICT'; account: SandboxFundingAccount; errorCode: string; requestId: string | null }
> {
  const basePath = `/api/v1/admin/sandbox-funding/accounts/${encodeURIComponent(requireUserId(userId))}`;
  const response = await client.post(`${basePath}/target-balance`, buildTargetBalanceRequest(account, targetProviderBalanceMinor));
  if (response.status === 409) {
    const envelope = await response.json().catch(() => null) as { requestId?: string; error?: { code?: string } } | null;
    return {
      kind: 'CONFLICT',
      account: await getSandboxFundingAccount(client, userId),
      errorCode: envelope?.error?.code ?? 'CONFLICT',
      requestId: envelope?.requestId ?? null
    };
  }
  return { kind: 'UPDATED', account: await readAccountResponse(response) };
}

async function readAccountResponse(response: Response): Promise<SandboxFundingAccount> {
  const envelope = await response.json().catch(() => null) as { data?: SandboxFundingAccount; requestId?: string; error?: { code?: string } } | null;
  if (!response.ok || !envelope?.data) {
    throw new Error(`${envelope?.error?.code ?? 'SANDBOX_FUNDING_FAILED'}:${envelope?.requestId ?? 'unknown'}`);
  }
  return envelope.data;
}

function requireUserId(userId: string): string {
  const value = userId.trim();
  if (!value) throw new Error('userId is required.');
  return value;
}
