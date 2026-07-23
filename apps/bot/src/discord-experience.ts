import type {
  MessageComponentSpec,
  MessageDensity,
  MessageFieldSpec,
  MessageSpec,
  MessageTone
} from './service-center-components.js';

export const DISCORD_EXPERIENCE = {
  density: {
    PUBLIC_WELCOME: 75,
    PUBLIC_MILESTONE: 70,
    PRIVATE_ORDER: 58,
    EPHEMERAL_FEEDBACK: 35,
    HIGH_RISK: 25
  },
  color: {
    BRAND: 0x6d5dfc,
    INFO: 0x4f8cff,
    SUCCESS: 0x35c48d,
    WAITING: 0xf0a84b,
    DANGER: 0xe35d6a,
    MUTED: 0x747f8d
  },
  footer: '黑猫陪玩 · Blackcat Companion',
  field: {
    bossRequest: '💬 老板需求',
    progress: '⏳ 当前进度',
    nextStep: '👉 下一步'
  }
} as const satisfies {
  density: Record<MessageDensity, number>;
  color: Record<MessageTone, number>;
  footer: string;
  field: Record<'bossRequest' | 'progress' | 'nextStep', string>;
};

export interface ExperienceMessageInput {
  title: string;
  icon?: string;
  introduction: string;
  visibility: MessageSpec['visibility'];
  density: MessageDensity;
  tone: MessageTone;
  coreFacts?: MessageFieldSpec[];
  bossRequest?: string | null;
  progress?: string | null;
  nextStep?: string | null;
  components: MessageComponentSpec[];
  layout?: MessageSpec['layout'];
  footer?: string;
  attachments?: MessageSpec['attachments'];
}

export function buildExperienceMessage(input: ExperienceMessageInput): MessageSpec {
  const fields = [...(input.coreFacts ?? [])];
  const bossRequest = input.bossRequest?.trim();
  const progress = input.progress?.trim();
  const nextStep = input.nextStep?.trim();

  if (bossRequest) {
    fields.push({
      name: DISCORD_EXPERIENCE.field.bossRequest,
      value: quoteBossRequest(bossRequest)
    });
  }
  if (progress) fields.push({ name: DISCORD_EXPERIENCE.field.progress, value: progress });
  if (nextStep) fields.push({ name: DISCORD_EXPERIENCE.field.nextStep, value: nextStep });

  return {
    title: withIcon(input.icon, input.title),
    body: input.introduction.trim(),
    visibility: input.visibility,
    components: input.components,
    ...(input.layout ? { layout: input.layout } : {}),
    tone: input.tone,
    density: input.density,
    ...(fields.length ? { fields } : {}),
    footer: input.footer?.trim() || DISCORD_EXPERIENCE.footer,
    ...(input.attachments?.length ? { attachments: input.attachments } : {})
  };
}

export function discordExperienceColor(tone: MessageTone | undefined, visibility: MessageSpec['visibility']): number {
  if (tone) return DISCORD_EXPERIENCE.color[tone];
  return visibility === 'PUBLIC' ? DISCORD_EXPERIENCE.color.BRAND : DISCORD_EXPERIENCE.color.INFO;
}

function withIcon(icon: string | undefined, title: string): string {
  const cleanTitle = title.trim();
  const cleanIcon = icon?.trim();
  return cleanIcon ? `${cleanIcon} ${cleanTitle}` : cleanTitle;
}

function quoteBossRequest(value: string): string {
  return value
    .split('\n')
    .map((line) => `> ${line || ' '}`)
    .join('\n');
}
