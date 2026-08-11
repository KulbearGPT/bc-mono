import { createHash } from 'node:crypto';

export interface NonUiFixtureIdentity {
  scenarioId: string;
  sequence: number;
  guildA: string;
  guildB: string;
  customerId: string;
  playerId: string;
  staffL1Id: string;
  staffL2Id: string;
  staffL3Id: string;
  staffL4AId: string;
  staffL4BId: string;
  discordCustomerId: string;
}

export function createGuildFixture(scenarioId: string, sequence: number) {
  const key = `${scenarioId}:${sequence}`;
  return {
    primary: {
      id: stableUuid(`${key}:guild-a`),
      discordGuildId: stableSnowflake(`${key}:discord-guild-a`),
      operationsChannelId: stableSnowflake(`${key}:operations-channel-a`),
      permissionsVersion: sequence + 1
    },
    secondary: {
      id: stableUuid(`${key}:guild-b`),
      discordGuildId: stableSnowflake(`${key}:discord-guild-b`),
      operationsChannelId: stableSnowflake(`${key}:operations-channel-b`),
      permissionsVersion: sequence + 1
    }
  };
}

export function createActorFixture(scenarioId: string, sequence: number): NonUiFixtureIdentity {
  const key = `${scenarioId}:${sequence}`;
  return {
    scenarioId,
    sequence,
    guildA: stableUuid(`${key}:guild-a`),
    guildB: stableUuid(`${key}:guild-b`),
    customerId: stableUuid(`${key}:customer`),
    playerId: stableUuid(`${key}:player`),
    staffL1Id: stableUuid(`${key}:staff-l1`),
    staffL2Id: stableUuid(`${key}:staff-l2`),
    staffL3Id: stableUuid(`${key}:staff-l3`),
    staffL4AId: stableUuid(`${key}:staff-l4-a`),
    staffL4BId: stableUuid(`${key}:staff-l4-b`),
    discordCustomerId: stableSnowflake(`${key}:discord-customer`)
  };
}

export function createAccountFixture(scenarioId: string, sequence: number) {
  const actors = createActorFixture(scenarioId, sequence);
  return {
    userId: actors.customerId,
    discordUserId: actors.discordCustomerId,
    guildId: actors.guildA,
    status: 'ACTIVE' as const,
    rowVersion: 1,
    profile: {
      displayName: `NUI Customer ${sequence}`,
      riskState: 'CLEAR' as const
    }
  };
}

export function stableUuid(value: string): string {
  const hex = createHash('sha256').update(value).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export function stableSnowflake(value: string): string {
  const hex = createHash('sha256').update(value).digest('hex').slice(0, 14);
  return (800_000_000_000_000_000n + (BigInt(`0x${hex}`) % 99_999_999_999_999_999n)).toString();
}
