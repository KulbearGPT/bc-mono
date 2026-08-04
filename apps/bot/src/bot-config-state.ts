import { randomUUID } from 'node:crypto';
import {
  BotConfigManageableField,
  BotConfigValue,
  BotConfigActorContext,
  BotConfigSnapshot,
  BotConfigValidationResult
} from './bot-config-contracts.js';

export class BotConfigCache {
  private readonly snapshots = new Map<string, BotConfigSnapshot>();

  public get(guildId: string): BotConfigSnapshot | undefined {
    return this.snapshots.get(guildId);
  }

  public set(snapshot: BotConfigSnapshot): void {
    this.snapshots.set(snapshot.guildId, structuredClone(snapshot));
  }
}

export interface BotConfigSession {
  id: string;
  guildId: string;
  discordUserId: string;
  version: number;
  selectedField?: BotConfigManageableField;
  currentValue?: BotConfigValue;
  proposedValue?: BotConfigValue;
  validation?: BotConfigValidationResult;
  reason?: string;
  expiresAt: number;
}

export class BotConfigSessionStore {
  private readonly sessions = new Map<string, BotConfigSession>();
  private readonly idFactory: () => string;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  public constructor(
    input: {
      idFactory?: () => string;
      now?: () => number;
      ttlMs?: number;
      maxEntries?: number;
    } = {}
  ) {
    this.idFactory = input.idFactory ?? (() => randomUUID().replaceAll('-', '').slice(0, 12));
    this.now = input.now ?? Date.now;
    this.ttlMs = input.ttlMs ?? 5 * 60_000;
    this.maxEntries = input.maxEntries ?? 1_000;
  }

  public create(actor: BotConfigActorContext, snapshot: BotConfigSnapshot): BotConfigSession {
    if (!actor.discordUserId) throw new Error('A human actor is required for a Bot config session.');
    const id = this.idFactory();
    if (!/^[A-Za-z0-9_-]{8,16}$/u.test(id)) throw new Error('Bot config session ids must be short and URL-safe.');
    this.prune();
    while (this.sessions.size >= this.maxEntries) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    const session = {
      id,
      guildId: actor.guildId,
      discordUserId: actor.discordUserId,
      version: snapshot.version,
      expiresAt: this.now() + this.ttlMs
    };
    this.sessions.set(id, session);
    return session;
  }

  public require(actor: BotConfigActorContext, sessionId: string): BotConfigSession {
    const session = this.sessions.get(sessionId);
    if (
      !session ||
      session.expiresAt <= this.now() ||
      session.guildId !== actor.guildId ||
      session.discordUserId !== actor.discordUserId
    ) {
      this.sessions.delete(sessionId);
      throw new Error('Bot config session is missing, expired, or belongs to another actor.');
    }
    return session;
  }

  public delete(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  private prune(): void {
    const now = this.now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt > now) continue;
      this.sessions.delete(id);
    }
  }
}
