import { Listener } from '@sapphire/framework';

export default class ReadyListener extends Listener {
  public override run(): void {
    this.container.logger.info('Sapphire bot ready.');
  }
}
