import { fileURLToPath } from 'node:url';

export interface BrandBanner {
  attachmentName: string;
  path: string;
  url: string;
}

export function resolveBlackcatWelcomeBanner(): BrandBanner {
  const attachmentName = 'blackcat-welcome.webp';
  return {
    attachmentName,
    path: fileURLToPath(new URL('../../api/assets/onboarding/welcome.webp', import.meta.url)),
    url: `attachment://${attachmentName}`
  };
}
