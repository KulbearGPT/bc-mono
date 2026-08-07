import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  ComponentType,
  GatewayIntentBits,
  PermissionFlagsBits,
  type Guild,
  type TextChannel
} from 'discord.js';
import { Pool } from 'pg';
import {
  bindM21ReviewUatEntryMessage,
  getM21ReviewUatBroadcastState,
  prepareM21ReviewUatFixture,
  requeueM21ReviewUatBroadcast,
  verifyM21ReviewFinalCheckpoint,
  verifyM21ReviewInternalCheckpoint
} from './m21-review-flow-fixture.js';

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

if (process.env.M21_UAT_CONFIRM !== 'USE_ISOLATED_REVIEW_UAT') {
  throw new Error('Set M21_UAT_CONFIRM=USE_ISOLATED_REVIEW_UAT to operate the isolated M21 review UAT.');
}
if (process.env.BUSINESS_ENV !== 'SANDBOX') throw new Error('M21 review UAT is restricted to BUSINESS_ENV=SANDBOX.');

const mode = process.argv[2];
if (
  !['prepare', 'check-internal', 'verify-final', 'requeue-broadcast', 'delete-and-requeue', 'cleanup'].includes(
    mode ?? ''
  )
) {
  throw new Error(
    'Usage: m21-review-flow-uat.ts prepare|check-internal|verify-final|requeue-broadcast|delete-and-requeue|cleanup'
  );
}
const databaseUrl = required('DATABASE_URL');
const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//u, ''));
if (!databaseName.includes('_uat')) throw new Error('DATABASE_URL must name an isolated database containing _uat.');
const token = required('DISCORD_BOT_TOKEN');
const guildId = required('DISCORD_GUILD_ID');
const runId = required('M21_UAT_RUN_ID');
const customerDiscordId = required('M21_UAT_CUSTOMER_ID');
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const pool =
  mode === 'cleanup' ? null : new Pool({ connectionString: databaseUrl, application_name: 'm21_review_uat' });
let runError: unknown;

try {
  await client.login(token);
  const guild = await client.guilds.fetch(guildId);
  await guild.channels.fetch();
  switch (mode) {
    case 'prepare':
      if (!pool) throw new Error('M21 review UAT database is unavailable.');
      await prepare(guild, pool);
      break;
    case 'check-internal':
      if (!pool) throw new Error('M21 review UAT database is unavailable.');
      await checkInternal(guild, pool);
      break;
    case 'verify-final':
      if (!pool) throw new Error('M21 review UAT database is unavailable.');
      await verifyFinal(guild, pool);
      break;
    case 'requeue-broadcast':
      if (!pool) throw new Error('M21 review UAT database is unavailable.');
      await requeueBroadcast(pool, false);
      break;
    case 'delete-and-requeue':
      if (!pool) throw new Error('M21 review UAT database is unavailable.');
      await requeueBroadcast(pool, true);
      break;
    case 'cleanup':
      await cleanup(guild);
      break;
  }
} catch (error) {
  runError = error;
} finally {
  await pool?.end().catch((error) => {
    runError ??= error;
  });
  client.destroy();
}

if (runError) throw runError;

async function prepare(guild: Guild, database: Pool) {
  const botMember = await guild.members.fetchMe();
  if (!botMember.permissions.has(PermissionFlagsBits.ManageChannels))
    throw new Error('Discord Bot requires Manage Channels for M21 review UAT setup and cleanup.');
  const customer = await guild.members.fetch(customerDiscordId);
  if (customer.user.bot) throw new Error('M21_UAT_CUSTOMER_ID must identify a real non-Bot Guild member.');
  const created: TextChannel[] = [];
  try {
    const interaction = await findOrCreateChannel(guild, 'interaction', created, {
      permissionOverwrites: [
        { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        {
          id: customer.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory
          ]
        },
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
    const review = await findOrCreateChannel(guild, 'review', created, {
      permissionOverwrites: [
        {
          id: guild.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
          deny: [PermissionFlagsBits.SendMessages]
        },
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
    const fixture = await prepareM21ReviewUatFixture(database, {
      runId,
      guildId,
      customerDiscordId,
      interactionChannelId: interaction.id,
      reviewChannelId: review.id,
      completedAt: new Date()
    });
    const recent = await interaction.messages.fetch({ limit: 100, cache: false });
    const customId = `bc:r:${fixture.orderId}:o`;
    let entry = recent.find((message) =>
      message.components.some(
        (row) =>
          row.type === ComponentType.ActionRow &&
          row.components.some((component) => 'customId' in component && component.customId === customId)
      )
    );
    if (!entry) {
      entry = await interaction.send({
        content: `M21 订单评价外部 UAT · ${fixture.orderPublicId}\n仅测试老板 <@${customer.id}> 可操作。`,
        allowedMentions: { users: [customer.id] },
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(customId).setLabel('评价本次服务').setStyle(ButtonStyle.Primary)
          )
        ]
      });
    }
    await bindM21ReviewUatEntryMessage(database, {
      runId,
      guildId,
      interactionChannelId: interaction.id,
      entryMessageId: entry.id
    });
    process.stdout.write(
      `${JSON.stringify(
        {
          acceptanceIds: ['AT-REVIEW-002', 'AT-REVIEW-003'],
          mode: 'prepare',
          runId,
          databaseName,
          guildId,
          customerDiscordId,
          orderId: fixture.orderId,
          orderPublicId: fixture.orderPublicId,
          interactionChannelId: interaction.id,
          reviewChannelId: review.id,
          entryMessageId: entry.id,
          temporaryResourcesRequireCleanup: true,
          status: 'READY_FOR_HUMAN_UAT'
        },
        null,
        2
      )}\n`
    );
  } catch (error) {
    await Promise.allSettled(created.map((channel) => channel.delete('M21 review flow UAT failed setup cleanup')));
    throw error;
  }
}

async function checkInternal(guild: Guild, database: Pool) {
  const review = requiredUatChannel(guild, 'review');
  const cards = await reviewCards(review);
  if (cards.length !== 0) throw new Error('Internal-save checkpoint found a public review card.');
  const result = await verifyM21ReviewInternalCheckpoint(database, {
    runId,
    guildId,
    customerDiscordId,
    reviewChannelId: review.id
  });
  process.stdout.write(`${JSON.stringify({ ...result, publicReviewMessageCount: 0 }, null, 2)}\n`);
}

async function verifyFinal(guild: Guild, database: Pool) {
  const review = requiredUatChannel(guild, 'review');
  const cards = await reviewCards(review);
  const result = await verifyM21ReviewFinalCheckpoint(database, {
    runId,
    guildId,
    customerDiscordId,
    reviewChannelId: review.id,
    visibleReviewMessageIds: cards.map((message) => message.id),
    renderedReviewCards: cards.map((message) =>
      JSON.stringify({ content: message.content, embeds: message.embeds.map((embed) => embed.toJSON()) })
    )
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function requeueBroadcast(database: Pool, deleteCurrent: boolean) {
  const context = { runId, guildId, customerDiscordId };
  if (deleteCurrent) {
    const state = await getM21ReviewUatBroadcastState(database, context);
    if (!state.previousMessageId) throw new Error('Published M21 review card has no message ID to delete.');
    const guild = client.guilds.cache.get(guildId);
    if (!guild) throw new Error('M21 review UAT Guild is unavailable.');
    const review = requiredUatChannel(guild, 'review');
    const message = await review.messages.fetch(state.previousMessageId);
    await message.delete();
  }
  const replay = await requeueM21ReviewUatBroadcast(database, context);
  process.stdout.write(
    `${JSON.stringify(
      {
        acceptanceId: 'AT-REVIEW-003',
        mode: deleteCurrent ? 'delete-and-requeue' : 'requeue-broadcast',
        ...replay,
        deletedPreviousMessage: deleteCurrent,
        status: 'QUEUED'
      },
      null,
      2
    )}\n`
  );
}

async function cleanup(guild: Guild) {
  const channels = guild.channels.cache.filter(
    (channel): channel is TextChannel =>
      channel.type === ChannelType.GuildText && channel.topic?.startsWith(`M21_REVIEW_UAT:${runId}:`) === true
  );
  const results = await Promise.allSettled(channels.map((channel) => channel.delete('M21 review flow UAT cleanup')));
  const failed = results.filter((result) => result.status === 'rejected');
  if (failed.length) throw new Error(`Failed to delete ${failed.length} M21 UAT Discord channel(s).`);
  process.stdout.write(
    `${JSON.stringify({ mode: 'cleanup', runId, deletedDiscordChannelCount: channels.size, status: 'PASS' }, null, 2)}\n`
  );
}

async function findOrCreateChannel(
  guild: Guild,
  kind: 'interaction' | 'review',
  created: TextChannel[],
  input: { permissionOverwrites: Array<{ id: string; allow?: bigint[]; deny?: bigint[] }> }
) {
  const topic = `M21_REVIEW_UAT:${runId}:${kind}`;
  const existing = guild.channels.cache.find(
    (channel): channel is TextChannel => channel.type === ChannelType.GuildText && channel.topic === topic
  );
  if (existing) return existing;
  const channel = await guild.channels.create({
    name: kind === 'interaction' ? `m21-review-${runId}` : `m21-review-public-${runId}`,
    type: ChannelType.GuildText,
    topic,
    permissionOverwrites: input.permissionOverwrites,
    reason: 'M21 order review external UAT'
  });
  created.push(channel);
  return channel;
}

function requiredUatChannel(guild: Guild, kind: 'interaction' | 'review') {
  const topic = `M21_REVIEW_UAT:${runId}:${kind}`;
  const channel = guild.channels.cache.find(
    (item): item is TextChannel => item.type === ChannelType.GuildText && item.topic === topic
  );
  if (!channel) throw new Error(`M21 ${kind} UAT channel was not found.`);
  return channel;
}

async function reviewCards(channel: TextChannel) {
  const botId = client.user?.id;
  if (!botId) throw new Error('Discord Bot identity is unavailable.');
  const recent = await channel.messages.fetch({ limit: 100, cache: false });
  return [...recent.values()].filter(
    (message) => message.author.id === botId && message.embeds[0]?.title === '🌟 老板五星好评'
  );
}
