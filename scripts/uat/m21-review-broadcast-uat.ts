import { randomUUID } from 'node:crypto';
import { ChannelType, Client, GatewayIntentBits, PermissionFlagsBits, type TextChannel } from 'discord.js';
import {
  InMemoryOrderReviewBroadcastStore,
  createOrderReviewBroadcastHandler,
  renderFiveStarReviewBroadcast
} from '../../apps/api/src/order-review-broadcast.js';
import { DiscordRestDeliveryAdapter } from '../../apps/api/src/worker-delivery.js';
import type { OutboxJob } from '../../apps/api/src/outbox.js';

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

if (process.env.M21_UAT_CONFIRM !== 'DELETE_TEMP_REVIEW_CHANNEL') {
  throw new Error(
    'Set M21_UAT_CONFIRM=DELETE_TEMP_REVIEW_CHANNEL to run the destructive, self-cleaning review broadcast UAT.'
  );
}

const token = required('DISCORD_BOT_TOKEN');
const guildId = required('DISCORD_GUILD_ID');
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
let channel: TextChannel | null = null;
let result: Record<string, unknown> | null = null;
let runError: unknown;

try {
  await client.login(token);
  const guild = await client.guilds.fetch(guildId);
  const botMember = await guild.members.fetchMe();
  if (!botMember.permissions.has(PermissionFlagsBits.ManageChannels)) {
    throw new Error('Discord Bot lacks Manage Channels for the temporary UAT channel.');
  }

  channel = await guild.channels.create({
    name: `m21-review-uat-${Date.now().toString(36).slice(-5)}`,
    type: ChannelType.GuildText,
    topic: 'Temporary M21 five-star review broadcast UAT; this channel is deleted automatically.',
    reason: 'M21 review broadcast UAT',
    permissionOverwrites: [
      {
        id: botMember.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageMessages
        ]
      }
    ]
  });

  // Discord enforces nonce uniqueness per author for several minutes, even after
  // a temporary UAT channel is deleted, so every probe needs fresh aggregate IDs.
  const publicationId = randomUUID();
  const orderId = randomUUID();
  const now = new Date().toISOString();
  const snapshot = {
    orderPublicId: 'M21-UAT-SAFE',
    serviceDisplayName: 'UAT 测试服务',
    completedAt: now,
    targets: [
      { targetType: 'ORDER' as const, displayName: '订单整体', score: 5 as const },
      { targetType: 'PLAYER' as const, displayName: '陪玩测试对象', score: 5 as const }
    ]
  };
  let unsafeSnapshotRejected = false;
  try {
    renderFiveStarReviewBroadcast({
      ...snapshot,
      targets: [{ ...snapshot.targets[0]!, comment: 'private-comment-sentinel' }]
    } as never);
  } catch {
    unsafeSnapshotRejected = true;
  }
  if (!unsafeSnapshotRejected) throw new Error('Private snapshot field was not rejected before Discord delivery.');

  const store = new InMemoryOrderReviewBroadcastStore({
    publications: [
      {
        id: publicationId,
        orderId,
        guildId,
        status: 'PENDING',
        snapshot,
        broadcastChannelId: null,
        broadcastMessageId: null,
        publishedAt: null
      }
    ],
    guildChannels: new Map([[guildId, channel.id]])
  });
  const handler = createOrderReviewBroadcastHandler({
    store,
    discord: new DiscordRestDeliveryAdapter({ botToken: token })
  });
  const job: OutboxJob = {
    id: randomUUID(),
    type: 'REVIEW_BROADCAST',
    status: 'PROCESSING',
    payload: { publicationId, orderId },
    aggregateType: 'order_review_publication',
    aggregateId: publicationId,
    dedupeKey: `review-publication:${orderId}`,
    attempts: 1,
    maxAttempts: 8,
    runAfter: now,
    lockedAt: now,
    lockedBy: 'm21-real-guild-uat',
    lastError: null,
    version: 1,
    createdAt: now,
    updatedAt: now
  };

  await handler(job);
  const firstMessageId = store.publications[0]?.broadcastMessageId;
  if (!firstMessageId) throw new Error('First Discord review broadcast did not persist a message ID.');
  const firstMessage = await channel.messages.fetch(firstMessageId);
  const rendered = JSON.stringify(firstMessage.embeds.map((embed) => embed.toJSON()));
  for (const expected of ['老板五星好评', 'M21-UAT-SAFE', '订单整体', '陪玩测试对象']) {
    if (!rendered.includes(expected)) throw new Error(`Discord review broadcast omitted ${expected}.`);
  }
  for (const forbidden of ['private-comment-sentinel', 'customer-id-sentinel', '1–4 星', '钱包', 'CAT']) {
    if (rendered.includes(forbidden)) throw new Error(`Discord review broadcast leaked ${forbidden}.`);
  }

  await handler({ ...job, attempts: 2 });
  const replayMessageId = store.publications[0]?.broadcastMessageId;
  if (replayMessageId !== firstMessageId) throw new Error('Outbox replay created a duplicate Discord review message.');

  await firstMessage.delete();
  await handler({ ...job, attempts: 3, updatedAt: new Date().toISOString() });
  const recoveredMessageId = store.publications[0]?.broadcastMessageId;
  if (!recoveredMessageId || recoveredMessageId === firstMessageId) {
    throw new Error('Deleted Discord review message was not recreated with a new message ID.');
  }
  const recent = await channel.messages.fetch({ limit: 100, cache: false });
  const reviewMessages = recent.filter(
    (message) => message.author.id === botMember.id && message.embeds[0]?.title === '🌟 老板五星好评'
  );
  if (reviewMessages.size !== 1 || !reviewMessages.has(recoveredMessageId)) {
    throw new Error('Review broadcast recovery did not converge to exactly one visible Discord message.');
  }

  result = {
    acceptanceId: 'AT-REVIEW-003',
    observedAt: new Date().toISOString(),
    guildId,
    channelId: channel.id,
    firstMessageId,
    replayMessageId,
    recoveredMessageId,
    safeSnapshotRendered: true,
    unsafeSnapshotRejected,
    replayDeduplicated: true,
    deletedMessageRecovered: true,
    visibleReviewMessageCount: reviewMessages.size,
    apiBusinessMutationCalls: 0,
    temporaryResourcesDeleted: true,
    status: 'PASS'
  };
} catch (error) {
  runError = error;
} finally {
  if (channel) {
    try {
      await channel.delete('M21 review broadcast UAT cleanup');
    } catch (error) {
      runError = runError
        ? new AggregateError([runError, error], 'M21 review broadcast UAT and cleanup failed.')
        : error;
    }
  }
  client.destroy();
}

if (runError) throw runError;
if (!result) throw new Error('M21 review broadcast UAT produced no result.');
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
