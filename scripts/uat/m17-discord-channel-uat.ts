import { ChannelType, Client, GatewayIntentBits, PermissionFlagsBits, type TextChannel } from 'discord.js';
import {
  createProvisionalPrivateOrderChannel,
  finalizePrivateOrderChannel
} from '../../apps/bot/src/private-order-channel.js';

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

if (process.env.M17_UAT_CONFIRM !== 'DELETE_TEMP_CHANNELS') {
  throw new Error('Set M17_UAT_CONFIRM=DELETE_TEMP_CHANNELS to run the destructive, self-cleaning Guild UAT.');
}

const token = required('DISCORD_BOT_TOKEN');
const guildId = required('DISCORD_GUILD_ID');
const apiBaseUrl = required('API_BASE_URL').replace(/\/+$/u, '');
const serviceToken = required('BOT_SERVICE_TOKEN');
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
const temporaryChannels: TextChannel[] = [];
let runError: unknown;

try {
  await client.login(token);
  const guild = await client.guilds.fetch(guildId);
  await guild.channels.fetch();
  const members = await guild.members.fetch();
  const botUserId = client.user?.id;
  if (!botUserId) throw new Error('Discord Bot user was not resolved after login.');

  const configResponse = await fetch(`${apiBaseUrl}/api/v1/admin/bot-config?guildId=${encodeURIComponent(guildId)}`, {
    headers: {
      authorization: `Bearer ${serviceToken}`,
      'x-client-source': 'DISCORD_BOT'
    }
  });
  const configEnvelope = (await configResponse.json()) as {
    requestId?: string;
    data?: { version: number; values: Record<string, unknown> };
    error?: { code?: string; message?: string };
  };
  if (!configResponse.ok || !configEnvelope.data) {
    throw new Error(`Bot configuration read failed: ${configEnvelope.error?.code ?? configResponse.status}`);
  }
  const values = configEnvelope.data.values;
  const categoryId = typeof values.private_order_category_id === 'string' ? values.private_order_category_id : null;
  if (!categoryId) throw new Error('private_order_category_id is not configured.');
  const category = guild.channels.cache.get(categoryId);
  if (!category || category.type !== ChannelType.GuildCategory) {
    throw new Error('Configured private order category is not available as a Guild category.');
  }

  const requestedCustomerId = process.env.M17_UAT_CUSTOMER_ID?.trim();
  const customer = requestedCustomerId ? members.get(requestedCustomerId) : members.find((member) => !member.user.bot);
  if (!customer || customer.user.bot)
    throw new Error('A non-Bot Guild member is required for the customer permission probe.');
  const staffRoleIds = [
    values.staff_l1_role_id,
    values.staff_l2_role_id,
    values.staff_l3_role_id,
    values.staff_l4_role_id
  ].filter((value): value is string => typeof value === 'string' && guild.roles.cache.has(value));
  if (staffRoleIds.length === 0) throw new Error('At least one configured staff role is required.');
  const playerRoleId =
    typeof values.player_role_id === 'string' && guild.roles.cache.has(values.player_role_id)
      ? values.player_role_id
      : null;

  const verify = async (channel: TextChannel, panelMessageId: string) => {
    let panelPinned = false;
    for (let attempt = 0; attempt < 10 && !panelPinned; attempt += 1) {
      panelPinned = (await channel.messages.fetchPins({ cache: false })).items.some(
        (pin) => pin.message.id === panelMessageId
      );
      if (!panelPinned) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const everyone = channel.permissionOverwrites.cache.get(guildId);
    const customerOverwrite = channel.permissionOverwrites.cache.get(customer.id);
    const botOverwrite = channel.permissionOverwrites.cache.get(botUserId);
    const staffOverwrites = staffRoleIds.map((roleId) => channel.permissionOverwrites.cache.get(roleId));
    const result = {
      parentApplied: channel.parentId === categoryId,
      panelPinned,
      everyoneViewDenied: everyone?.deny.has(PermissionFlagsBits.ViewChannel) === true,
      customerViewAllowed: customerOverwrite?.allow.has(PermissionFlagsBits.ViewChannel) === true,
      customerSendAllowed: customerOverwrite?.allow.has(PermissionFlagsBits.SendMessages) === true,
      customerManageDenied: customerOverwrite?.deny.has(PermissionFlagsBits.ManageChannels) === true,
      botManageAllowed: botOverwrite?.allow.has(PermissionFlagsBits.ManageChannels) === true,
      allConfiguredStaffManageAllowed: staffOverwrites.every(
        (overwrite) => overwrite?.allow.has(PermissionFlagsBits.ManageChannels) === true
      ),
      playerViewDenied: playerRoleId
        ? channel.permissionOverwrites.cache.get(playerRoleId)?.deny.has(PermissionFlagsBits.ViewChannel) === true
        : null
    };
    if (Object.values(result).some((value) => value === false)) {
      throw new Error(`Permission or pin verification failed: ${JSON.stringify(result)}`);
    }
    return result;
  };

  const first = await createProvisionalPrivateOrderChannel({
    guild,
    guildId,
    categoryId,
    customerDiscordUserId: customer.id,
    botUserId,
    staffRoleIds,
    playerRoleId,
    provisionalName: 'm17-uat-primary'
  });
  temporaryChannels.push(first.channel);
  const firstChecks = await verify(first.channel, first.panelMessageId);
  await finalizePrivateOrderChannel({
    channel: first.channel,
    panel: first.panel,
    orderPublicId: 'M17-UAT-PRIMARY',
    message: { content: 'M17 private order channel UAT — finalized.' }
  });
  const firstNameFinalized = first.channel.name === '订单-m17-uat-primary';
  if (!firstNameFinalized) throw new Error('Final channel name was not applied.');
  await first.channel.delete('M17 UAT recovery setup');
  temporaryChannels.splice(temporaryChannels.indexOf(first.channel), 1);

  const recovered = await createProvisionalPrivateOrderChannel({
    guild,
    guildId,
    categoryId,
    customerDiscordUserId: customer.id,
    botUserId,
    staffRoleIds,
    playerRoleId,
    provisionalName: 'm17-uat-recovered'
  });
  temporaryChannels.push(recovered.channel);
  const recoveryChecks = await verify(recovered.channel, recovered.panelMessageId);

  console.log(
    JSON.stringify(
      {
        acceptanceId: 'AT-BOT-REV-001',
        observedAt: new Date().toISOString(),
        guildId,
        configVersion: configEnvelope.data.version,
        configRequestId: configEnvelope.requestId,
        customerId: customer.id,
        staffRoleCount: staffRoleIds.length,
        first: { channelId: first.channelId, panelMessageId: first.panelMessageId, ...firstChecks, firstNameFinalized },
        recovery: { channelId: recovered.channelId, panelMessageId: recovered.panelMessageId, ...recoveryChecks },
        apiBusinessMutationCalls: 0,
        temporaryResourcesWillBeDeleted: true,
        status: 'PASS'
      },
      null,
      2
    )
  );
} catch (error) {
  runError = error;
} finally {
  const cleanup = await Promise.allSettled(temporaryChannels.map((channel) => channel.delete('M17 UAT cleanup')));
  client.destroy();
  const failures = cleanup.filter((result) => result.status === 'rejected');
  if (failures.length > 0) {
    const cleanupError = new Error(`Failed to clean ${failures.length} temporary Discord channel(s).`);
    runError = runError
      ? new AggregateError([runError, cleanupError], 'M17 Guild UAT and cleanup failed.')
      : cleanupError;
  }
}

if (runError) throw runError;
