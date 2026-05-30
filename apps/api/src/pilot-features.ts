export type PilotFeature = 'CORE_ORDER' | 'GIFTS' | 'REFERRALS' | 'M6';
export type PilotPhase = 'CORE_ORDER' | 'CORE_ORDER_AND_GIFTS' | 'OFF';

const FEATURES_BY_PHASE: Readonly<Record<PilotPhase, readonly PilotFeature[]>> = Object.freeze({
  CORE_ORDER: Object.freeze(['CORE_ORDER'] as const),
  CORE_ORDER_AND_GIFTS: Object.freeze(['CORE_ORDER', 'GIFTS'] as const),
  OFF: Object.freeze(['CORE_ORDER', 'GIFTS', 'REFERRALS', 'M6'] as const)
});

export interface PilotFeaturePolicy {
  readonly phase: PilotPhase;
  readonly enabledFeatures: readonly PilotFeature[];
  isEnabled(feature: PilotFeature): boolean;
}

export function parsePilotPhase(value: string | undefined): PilotPhase {
  const candidate = value?.trim();
  if (candidate === 'CORE_ORDER' || candidate === 'CORE_ORDER_AND_GIFTS' || candidate === 'OFF') {
    return candidate;
  }
  throw new Error('PILOT_PHASE must be explicitly set to CORE_ORDER, CORE_ORDER_AND_GIFTS, or OFF.');
}

export function createPilotFeaturePolicy(value: string | undefined): PilotFeaturePolicy {
  const phase = parsePilotPhase(value);
  const enabledFeatures = FEATURES_BY_PHASE[phase];
  return Object.freeze({
    phase,
    enabledFeatures,
    isEnabled: (feature: PilotFeature) => enabledFeatures.includes(feature)
  });
}
