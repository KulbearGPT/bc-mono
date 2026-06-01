export type PilotFeature = 'CORE_ORDER' | 'GIFTS' | 'REFERRALS' | 'M6';

export interface PilotDashboardCapabilities {
  permissions: string[];
  enabledFeatures: PilotFeature[];
  businessEnvironment: 'SANDBOX' | 'PRODUCTION';
  displayRole: 'STAFF' | 'OWNER' | null;
}

export const SANDBOX_WARNING = 'SANDBOX 测试环境 · 猫条余额不代表已收到 USD';

export function getSandboxBanner(environment: 'SANDBOX' | 'PRODUCTION'): string | null {
  return environment === 'SANDBOX' ? SANDBOX_WARNING : null;
}

export function resolveDashboardBusinessEnvironment(
  publicEnvironment: unknown,
  authenticatedEnvironment: unknown
): 'SANDBOX' | 'PRODUCTION' | undefined {
  if (authenticatedEnvironment === 'SANDBOX' || authenticatedEnvironment === 'PRODUCTION') return authenticatedEnvironment;
  if (publicEnvironment === 'SANDBOX' || publicEnvironment === 'PRODUCTION') return publicEnvironment;
  return undefined;
}

export function hasFeature(
  capabilities: Pick<PilotDashboardCapabilities, 'enabledFeatures'>,
  feature: PilotFeature
): boolean {
  return capabilities.enabledFeatures.includes(feature);
}
