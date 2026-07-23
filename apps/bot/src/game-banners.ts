import { fileURLToPath } from 'node:url';

interface GameBannerRule {
  fileName: string;
  aliases: RegExp;
}

const GAME_BANNER_RULES: GameBannerRule[] = [
  { fileName: 'league-of-legends.png', aliases: /英雄联盟|league of legends|\blol(?:na)?\b/iu },
  { fileName: 'valorant.png', aliases: /无畏契约|瓦洛兰特|valorant/iu },
  { fileName: 'delta-force.png', aliases: /三角洲|delta force|\bdelta\b/iu },
  { fileName: 'apex-legends.png', aliases: /apex/iu },
  { fileName: 'pubg.png', aliases: /绝地求生|pubg/iu },
  { fileName: 'cs2-csgo.png', aliases: /cs2|csgo|counter.?strike/iu },
  { fileName: 'overwatch.png', aliases: /守望先锋|overwatch/iu },
  { fileName: 'naraka-bladepoint.png', aliases: /永劫无间|naraka/iu },
  { fileName: 'dota2.png', aliases: /dota\s*2?/iu },
  { fileName: 'tft.png', aliases: /金铲铲|云顶|teamfight|\btft\b/iu },
  { fileName: 'chat-minigames.png', aliases: /聊天|小游戏|chat|minigame/iu },
  { fileName: 'singing-voice.png', aliases: /唱歌|声优|singing|voice/iu }
];

export interface GameBanner {
  fileName: string;
  attachmentName: string;
  path: string;
  url: string;
}

export function resolveGameBanner(game: string, displayName?: string | null): GameBanner {
  const source = `${game} ${displayName ?? ''}`.trim();
  const fileName = GAME_BANNER_RULES.find((rule) => rule.aliases.test(source))?.fileName ?? 'other.png';
  const attachmentName = `blackcat-game-${fileName}`;
  return {
    fileName,
    attachmentName,
    path: fileURLToPath(new URL(`../../api/assets/game-banners/${fileName}`, import.meta.url)),
    url: `attachment://${attachmentName}`
  };
}
