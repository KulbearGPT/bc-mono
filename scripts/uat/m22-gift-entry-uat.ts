import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  ChannelType,
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
  type Message,
  type TextChannel
} from 'discord.js';
import { Pool } from 'pg';
import { PostgresOnboardingStore } from '../../apps/api/src/onboarding.js';
import { buildApiServer } from '../../apps/api/src/server.js';
import { InMemoryAuditSink, InMemoryIdempotencyStore } from '../../apps/api/src/security.js';
import { toDiscordReply } from '../../apps/bot/src/discord-renderer.js';
import { HttpOnboardingApiClient } from '../../apps/bot/src/onboarding.js';
import {
  buildStandaloneGiftEntryMessage,
  ensureStandaloneGiftEntryMessage,
  STANDALONE_GIFT_ENTRY_CUSTOM_ID
} from '../../apps/bot/src/standalone-gifts.js';
import { applyCurrentMigrations } from '../../tests/support/postgres-migrations.js';

const execFile = promisify(execFileCallback);
const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

if (process.env.BUSINESS_ENV !== 'SANDBOX') {
  throw new Error('M22 gift entry UAT is restricted to BUSINESS_ENV=SANDBOX.');
}
if (process.env.M22_UAT_CONFIRM !== 'DELETE_TEMP_GIFT_CHANNEL') {
  throw new Error('Set M22_UAT_CONFIRM=DELETE_TEMP_GIFT_CHANNEL to run the destructive, self-cleaning Guild UAT.');
}

const token = required('DISCORD_BOT_TOKEN');
const guildId = required('DISCORD_GUILD_ID');
const serviceToken = `m22-gift-entry-uat-${'s'.repeat(32)}`;
const databaseName = 'blackcat_m22_gift_entry_uat';
const postgresPort = 62_600 + (process.pid % 200);
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
let root = '';
let dataDirectory = '';
let postgresStarted = false;
let pool: Pool | null = null;
let apiServer: ReturnType<typeof buildApiServer> | null = null;
let channel: TextChannel | null = null;
let probe: Record<string, unknown> | null = null;
let runError: unknown;

try {
  root = await mkdtemp(join(tmpdir(), 'blackcat-m22-gift-entry-uat-'));
  dataDirectory = join(root, 'data');
  await execFile('initdb', ['-D', dataDirectory, '--no-locale', '--encoding=UTF8']);
  await execFile('pg_ctl', [
    '-D',
    dataDirectory,
    '-o',
    `-p ${postgresPort} -k ${root}`,
    '-l',
    join(root, 'postgres.log'),
    'start'
  ]);
  postgresStarted = true;
  await execFile('createdb', ['-h', root, '-p', String(postgresPort), databaseName]);
  await applyCurrentMigrations({ host: root, port: postgresPort, database: databaseName });

  await client.login(token);
  const guild = await client.guilds.fetch(guildId);
  const botMember = await guild.members.fetchMe();
  if (!botMember.permissions.has(PermissionFlagsBits.ManageChannels)) {
    throw new Error('Discord Bot lacks Manage Channels for the temporary M22 UAT channel.');
  }

  channel = await guild.channels.create({
    name: `m22-gift-uat-${Date.now().toString(36).slice(-5)}`,
    type: ChannelType.GuildText,
    topic: 'Temporary M22 standalone gift entry recovery UAT; this channel is deleted automatically.',
    reason: 'M22 standalone gift entry UAT',
    permissionOverwrites: [
      { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: botMember.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageMessages
        ]
      }
    ]
  });

  let runtime = await startProjectionApi();
  apiServer = runtime.server;
  pool = runtime.pool;
  const first = await ensureStandaloneGiftEntryMessage({ guild, channelId: channel.id, api: runtime.client });
  const firstMessage = await waitForPinnedMessage(channel, first.messageId);
  const firstInspection = inspectEntryMessage(firstMessage, botMember.id);
  if (!first.created || !first.pinned || !firstInspection.valid) {
    throw new Error(`Initial gift entry card verification failed: ${JSON.stringify({ first, firstInspection })}`);
  }

  const repeated = await ensureStandaloneGiftEntryMessage({ guild, channelId: channel.id, api: runtime.client });
  if (repeated.created || repeated.messageId !== first.messageId) {
    throw new Error('Repeated reconciliation did not reuse the persistent gift entry message.');
  }

  const payload = toDiscordReply(buildStandaloneGiftEntryMessage());
  const duplicate = await channel.send({
    embeds: payload.embeds,
    components: payload.components,
    allowedMentions: { parse: [] }
  });
  const deduplicated = await ensureStandaloneGiftEntryMessage({ guild, channelId: channel.id, api: runtime.client });
  if (deduplicated.messageId !== first.messageId || deduplicated.removedDuplicates !== 1) {
    throw new Error('Duplicate gift entry card did not converge to the projected message.');
  }
  const duplicateStillExists = await channel.messages.fetch({ message: duplicate.id, cache: false, force: true }).then(
    () => true,
    () => false
  );
  if (duplicateStillExists) throw new Error('Duplicate gift entry message remained visible after reconciliation.');

  const projectionBeforeRestart = await runtime.client.getGiftEntryMessage(guild.id);
  await apiServer.close();
  apiServer = null;
  await pool.end();
  pool = null;
  runtime = await startProjectionApi();
  apiServer = runtime.server;
  pool = runtime.pool;
  const projectionAfterRestart = await runtime.client.getGiftEntryMessage(guild.id);
  if (projectionAfterRestart?.messageId !== projectionBeforeRestart?.messageId) {
    throw new Error('Gift entry projection did not survive API and client reconstruction.');
  }

  await firstMessage.delete();
  const recovered = await ensureStandaloneGiftEntryMessage({ guild, channelId: channel.id, api: runtime.client });
  if (!recovered.created || recovered.messageId === first.messageId) {
    throw new Error('Deleted gift entry message was not recreated with a new message ID.');
  }
  const recoveredMessage = await waitForPinnedMessage(channel, recovered.messageId);
  const recoveredInspection = inspectEntryMessage(recoveredMessage, botMember.id);
  const recent = await channel.messages.fetch({ limit: 100, cache: false });
  const visibleEntries = recent.filter(
    (message) => message.author.id === botMember.id && hasCustomId(message, STANDALONE_GIFT_ENTRY_CUSTOM_ID)
  );
  const finalProjection = await runtime.client.getGiftEntryMessage(guild.id);
  if (!recoveredInspection.valid || visibleEntries.size !== 1 || finalProjection?.messageId !== recovered.messageId) {
    throw new Error(
      `Recovered gift entry verification failed: ${JSON.stringify({ recoveredInspection, visibleCount: visibleEntries.size, finalProjection })}`
    );
  }

  probe = {
    acceptanceId: 'AT-GIFT2-004',
    observedAt: new Date().toISOString(),
    guildId,
    channelId: channel.id,
    firstMessageId: first.messageId,
    repeatedMessageId: repeated.messageId,
    recoveredMessageId: recovered.messageId,
    initiallyPinned: firstInspection.pinned,
    requiredButtonsPresent: firstInspection.requiredButtonsPresent,
    personalBalanceAbsentFromPublicCard: firstInspection.personalBalanceAbsent,
    repeatedEnsureReusedMessage: repeated.messageId === first.messageId,
    duplicateRemoved: !duplicateStillExists,
    durableProjectionSurvivedApiClientReconstruction:
      projectionAfterRestart?.messageId === projectionBeforeRestart?.messageId,
    deletedMessageRecovered: recovered.messageId !== first.messageId,
    finalVisibleEntryCount: visibleEntries.size,
    finalProjectionMatchesDiscord: finalProjection?.messageId === recovered.messageId,
    apiBusinessMutationCalls: 0,
    humanDesktopMobileInteraction: 'PENDING',
    status: 'PASS_AUTOMATED_PROBE'
  };
} catch (error) {
  runError = error;
} finally {
  if (apiServer) await apiServer.close().catch((error) => appendCleanupError(error));
  if (pool) await pool.end().catch((error) => appendCleanupError(error));
  if (channel)
    await channel.delete('M22 standalone gift entry UAT cleanup').catch((error) => appendCleanupError(error));
  client.destroy();
  if (postgresStarted && dataDirectory) {
    await execFile('pg_ctl', ['-D', dataDirectory, 'stop', '-m', 'fast']).catch((error) => appendCleanupError(error));
  }
  if (root) await rm(root, { recursive: true, force: true }).catch((error) => appendCleanupError(error));
}

if (runError) throw runError;
if (!probe) throw new Error('M22 gift entry UAT produced no result.');
process.stdout.write(
  `${JSON.stringify(
    {
      ...probe,
      temporaryDatabase: 'DELETED',
      temporaryDiscordChannel: 'DELETED'
    },
    null,
    2
  )}\n`
);

async function startProjectionApi() {
  const nextPool = new Pool({ host: root, port: postgresPort, database: databaseName });
  const server = buildApiServer({
    env: {
      NODE_ENV: 'development',
      DATABASE_URL: '',
      API_PORT: '0',
      API_BASE_URL: 'http://127.0.0.1:0',
      BOT_SERVICE_TOKEN: serviceToken
    },
    security: {
      auditSink: new InMemoryAuditSink(),
      idempotencyStore: new InMemoryIdempotencyStore(),
      businessEnvironment: 'SANDBOX'
    },
    onboarding: { store: new PostgresOnboardingStore(nextPool) }
  });
  const apiBaseUrl = await server.listen({ host: '127.0.0.1', port: 0 });
  return {
    pool: nextPool,
    server,
    client: new HttpOnboardingApiClient({ apiBaseUrl, botServiceToken: serviceToken })
  };
}

function inspectEntryMessage(message: Message, botUserId: string) {
  const json = JSON.stringify({ content: message.content, embeds: message.embeds, components: message.components });
  const requiredButtonsPresent = [
    STANDALONE_GIFT_ENTRY_CUSTOM_ID,
    'bc:profile:open',
    'bc:service-center:recharge'
  ].every((customId) => hasCustomId(message, customId));
  const personalBalanceAbsent = !/(?:ledgerBalanceMinor|reservedMinor|availableMinor|当前可用猫条|\d+\s*CAT)/u.test(
    json
  );
  return {
    pinned: message.pinned,
    requiredButtonsPresent,
    personalBalanceAbsent,
    valid: message.author.id === botUserId && message.pinned && requiredButtonsPresent && personalBalanceAbsent
  };
}

function hasCustomId(message: Message, customId: string) {
  return message.components.some((row) =>
    row.components.some((component) => 'customId' in component && component.customId === customId)
  );
}

async function waitForPinnedMessage(channel: TextChannel, messageId: string) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const message = await channel.messages.fetch({ message: messageId, cache: false, force: true });
    if (message.pinned) return message;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Discord message ${messageId} did not become pinned within the UAT polling window.`);
}

function appendCleanupError(error: unknown) {
  runError = runError ? new AggregateError([runError, error], 'M22 gift entry UAT and cleanup failed.') : error;
}
