import { SapphireClient } from '@sapphire/framework';
import { GatewayIntentBits } from 'discord.js';
import { validateRuntimeEnv } from '@blackcat/platform/env';
import { discoverSapphirePieces } from './piece-manifest.js';
import { configureDiscordRendererEnvironment } from './discord-renderer.js';
import { processHealthPort, requireProductionServiceEnv, startProcessHealthServer } from '@blackcat/platform/process-health';

requireProductionServiceEnv('bot', process.env);
const validation = validateRuntimeEnv(process.env, { allowMissingDiscordToken: true });
configureDiscordRendererEnvironment(process.env.BUSINESS_ENV);
let ready = false;

if (!validation.ok) {
  console.error(JSON.stringify({ level: 'error', event: 'bot.config.invalid', errors: validation.errors }));
  process.exit(1);
}
const health = await startProcessHealthServer({ port: processHealthPort(process.env.PORT), isReady: () => ready });

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
  const client = new SapphireClient({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildPresences]
  });
  await client.login(validation.values.discordBotToken);
  const apiHealth = await fetch(new URL('/health', validation.values.apiBaseUrl));
  if (!apiHealth.ok) throw new Error('Unified API health check failed during Bot startup.');
  ready = true;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      ready = false;
      client.destroy();
      void health.close().finally(() => process.exit(0));
    });
  }
}
