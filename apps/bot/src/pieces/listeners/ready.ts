import { Events, Listener } from '@sapphire/framework';

export default class ReadyListener extends Listener {
  public constructor(context: Listener.LoaderContext) {
    super(context, { event: Events.ClientReady, once: true });
  }

  public override async run(): Promise<void> {
    this.container.logger.info({ event: 'bot.discord_gateway.ready' });
  }
}
