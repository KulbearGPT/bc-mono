import { Events,Listener } from '@sapphire/framework';
import type { Message } from 'discord.js';
import { orderChannelTranscriptApi } from '../../order-channel-transcript.js';
export default class MessageCreateListener extends Listener<typeof Events.MessageCreate>{public constructor(context:Listener.LoaderContext){super(context,{event:Events.MessageCreate});}public async run(message:Message){try{await orderChannelTranscriptApi.record(message,'CREATED');}catch(error){this.container.logger.error({event:'bot.transcript.create_failed',guildId:message.guildId,channelId:message.channelId,messageId:message.id,error});}}}
