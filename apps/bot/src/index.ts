import { ApplicationCommandRegistries, SapphireClient } from '@sapphire/framework';
import { GatewayIntentBits, Partials } from 'discord.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRuntimeEnv } from '@blackcat/platform/env';
import { discoverSapphirePieces } from './piece-manifest.js';
import { parseWalletDisplayConfig } from './wallet-display.js';
import { configureDiscordRendererEnvironment } from './discord-renderer.js';
import {
  processHealthPort,
  requireProductionServiceEnv,
  startProcessHealthServer
} from '@blackcat/platform/process-health';
import { BotReadinessState } from './runtime.js';
import { initializeLiveBotRuntime } from './runtime-startup.js';

const isProductionRuntime = process.env.NODE_ENV === 'production';
if (isProductionRuntime) requireProductionServiceEnv('bot', process.env);

const validation = validateRuntimeEnv(process.env, { allowMissingDiscordToken: true });
configureDiscordRendererEnvironment(process.env.BUSINESS_ENV);
const readiness = new BotReadinessState();

if (!validation.ok) {
  console.error(JSON.stringify({ level: 'error', event: 'bot.config.invalid', errors: validation.errors }));
  process.exit(1);
}
const health = isProductionRuntime
  ? await startProcessHealthServer({ port: processHealthPort(process.env.PORT), isReady: () => readiness.isReady() })
  : undefined;

try {
  parseWalletDisplayConfig(process.env);
} catch (error) {
  console.error(
    JSON.stringify({
      level: 'error',
      event: 'bot.wallet_display.invalid',
      error: error instanceof Error ? error.message : 'Invalid wallet display configuration.'
    })
  );
  process.exit(1);
}

const manifest = await discoverSapphirePieces();
console.log(JSON.stringify({ level: 'info', event: 'bot.pieces.discovered', pieces: manifest.pieces }));

if (!validation.values.discordBotToken) {
  console.warn(
    JSON.stringify({
      level: 'warn',
      event: 'bot.discord.login.skipped',
      reason: 'DISCORD_BOT_TOKEN is not configured'
    })
  );
} else {
  const configuredGuildId = process.env.DISCORD_GUILD_ID?.trim();
  if (configuredGuildId) ApplicationCommandRegistries.setDefaultGuildIds([configuredGuildId]);
  const client = new SapphireClient({
    baseUserDirectory: join(dirname(fileURLToPath(import.meta.url)), 'pieces'),
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildPresences,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User]
  });
  await client.login(validation.values.discordBotToken);
  const runtime = await initializeLiveBotRuntime({
    client,
    readiness,
    apiBaseUrl: validation.values.apiBaseUrl,
    botServiceToken: validation.values.botServiceToken,
    roleMappingVersion: process.env.DISCORD_ROLE_MAPPING_VERSION,
    logger: console
  });
  void runtime.backgroundDone.then((result) => {
    console.log(JSON.stringify({ level: 'info', event: 'bot.background_reconciliation.complete', ...result }));
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      readiness.markStopping();
      client.destroy();
      void health?.close().finally(() => process.exit(0));
    });
  }
}
