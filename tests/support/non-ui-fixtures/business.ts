import { createActorFixture, stableUuid } from './actors';

export interface WalletFixture {
  accountId: string;
  ledgerBalanceMinor: number;
  reservedMinor: number;
  availableMinor: number;
  currency: 'CAT';
  version: number;
}

export function createWalletFixture(scenarioId: string, sequence: number): WalletFixture {
  const ledgerBalanceMinor = 300_000 + sequence * 100;
  const reservedMinor = 20_000 + sequence;
  return {
    accountId: stableUuid(`${scenarioId}:${sequence}:wallet`),
    ledgerBalanceMinor,
    reservedMinor,
    availableMinor: ledgerBalanceMinor - reservedMinor,
    currency: 'CAT',
    version: sequence + 1
  };
}

export function createCatalogFixture(scenarioId: string, sequence: number) {
  const key = `${scenarioId}:${sequence}`;
  return {
    serviceId: stableUuid(`${key}:service`),
    versionId: stableUuid(`${key}:service-version`),
    customerPriceMinor: 20_000,
    playerPriceMinor: 15_000,
    currency: 'CAT' as const,
    status: 'ACTIVE' as const
  };
}

export function createPlayerFixture(scenarioId: string, sequence: number) {
  const actors = createActorFixture(scenarioId, sequence);
  return {
    profileId: stableUuid(`${scenarioId}:${sequence}:player-profile`),
    userId: actors.playerId,
    status: 'ACTIVE' as const,
    rowVersion: 1
  };
}

export function createOrderFixture(scenarioId: string, sequence: number) {
  const key = `${scenarioId}:${sequence}`;
  return {
    id: stableUuid(`${key}:order`),
    publicId: `P-NUI-${String(sequence).padStart(4, '0')}`,
    status: 'DRAFT' as const,
    version: 1,
    participantIds: [stableUuid(`${key}:participant-1`)]
  };
}

export function createReferralFixture(scenarioId: string, sequence: number) {
  const actors = createActorFixture(scenarioId, sequence);
  return {
    relationId: stableUuid(`${scenarioId}:${sequence}:referral`),
    beneficiaryId: actors.playerId,
    status: 'ACTIVE' as const
  };
}

export function createSettlementFixture(scenarioId: string, sequence: number) {
  return {
    batchId: stableUuid(`${scenarioId}:${sequence}:settlement`),
    currency: 'CAT' as const,
    status: 'DRAFT' as const,
    amountMinor: 15_000
  };
}

export function createJobFixture(scenarioId: string, sequence: number) {
  return {
    id: stableUuid(`${scenarioId}:${sequence}:job`),
    dedupeKey: `nui:${scenarioId.toLowerCase()}:${sequence}`,
    status: 'PENDING' as const,
    attempts: 0
  };
}

export function createFixtureKernel(scenarioId: string, sequence: number) {
  const actors = createActorFixture(scenarioId, sequence);
  return {
    scenarioId,
    sequence,
    now: new Date(Date.UTC(2026, 0, 1, 0, sequence % 60)).toISOString(),
    actors,
    wallet: createWalletFixture(scenarioId, sequence),
    catalog: createCatalogFixture(scenarioId, sequence),
    player: createPlayerFixture(scenarioId, sequence),
    order: createOrderFixture(scenarioId, sequence),
    referral: createReferralFixture(scenarioId, sequence),
    settlement: createSettlementFixture(scenarioId, sequence),
    job: createJobFixture(scenarioId, sequence)
  };
}
