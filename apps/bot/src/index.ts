import { SapphireClient } from '@sapphire/framework';
import { GatewayIntentBits } from 'discord.js';
import { validateRuntimeEnv } from '@blackcat/platform/env';
import { discoverSapphirePieces } from './piece-manifest.js';
import { configureDiscordRendererEnvironment } from './discord-renderer.js';

const validation = validateRuntimeEnv(process.env, { allowMissingDiscordToken: true });
configureDiscordRendererEnvironment(process.env.BUSINESS_ENV);

if (!validation.ok) {
  console.error(JSON.stringify({ level: 'error', event: 'bot.config.invalid', errors: validation.errors }));
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
  const client = new SapphireClient({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildPresences]
  });
  await client.login(validation.values.discordBotToken);
}
