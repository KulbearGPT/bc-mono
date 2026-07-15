import type { Message, PartialMessage } from 'discord.js';
import { BotApiTransport, BotApiTransportError } from './api-transport.js';
import { botConfigCache } from './bot-config.js';

export type TranscriptEventType = 'CREATED' | 'UPDATED' | 'DELETED';
export class OrderChannelTranscriptApi {
  private readonly transport: BotApiTransport;
  constructor(input: {
    apiBaseUrl: string;
    botServiceToken: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
    transport?: BotApiTransport;
  }) {
    this.transport = input.transport ?? new BotApiTransport(input);
  }
  async record(message: Message | PartialMessage, eventType: TranscriptEventType): Promise<void> {
    if (!message.guildId) return;
    const categoryId = botConfigCache.get(message.guildId)?.values.private_order_category_id;
    const channel = message.channel;
    const directParent = 'parentId' in channel ? channel.parentId : null;
    const grandParent =
      'parent' in channel && channel.parent && 'parentId' in channel.parent ? channel.parent.parentId : null;
    if (typeof categoryId !== 'string' || (directParent !== categoryId && grandParent !== categoryId)) return;
    const edited = message.editedTimestamp ? new Date(message.editedTimestamp).toISOString() : null;
    const eventId = `${message.id}:${eventType}:${eventType === 'UPDATED' ? (edited ?? 'unknown') : 'v1'}`;
    const body = {
      guildId: message.guildId,
      channelId: message.channelId,
      messageId: message.id,
      eventId,
      eventType,
      authorDiscordId: message.author?.id ?? null,
      authorDisplayName: message.member?.displayName ?? message.author?.globalName ?? message.author?.username ?? null,
      authorIsBot: message.author?.bot ?? null,
      content: message.content ?? null,
      embeds: message.embeds?.map((item) => item.toJSON()) ?? [],
      attachments:
        message.attachments?.map((item) => ({
          id: item.id,
          name: item.name,
          size: item.size,
          contentType: item.contentType,
          url: item.url
        })) ?? [],
      replyToMessageId: message.reference?.messageId ?? null,
      discordCreatedAt: message.createdTimestamp ? new Date(message.createdTimestamp).toISOString() : null,
      discordEditedAt: edited
    };
    try {
      await this.transport.request('/api/v1/internal/order-channel-events', {
        method: 'POST',
        idempotencyKey: `transcript:${eventId}`.replaceAll(/[^A-Za-z0-9:_-]/gu, '_').slice(0, 200),
        body
      });
    } catch (error) {
      if (error instanceof BotApiTransportError && error.statusCode === 404 && error.code === 'NOT_FOUND') return;
      throw error;
    }
  }
}
export const orderChannelTranscriptApi = new OrderChannelTranscriptApi({
  apiBaseUrl: process.env.API_BASE_URL ?? '',
  botServiceToken: process.env.BOT_SERVICE_TOKEN ?? ''
});
