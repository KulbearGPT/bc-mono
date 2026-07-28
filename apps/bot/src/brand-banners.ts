import { fileURLToPath } from 'node:url';

export interface BrandBanner {
  attachmentName: string;
  path: string;
  url: string;
}

export function resolveBlackcatWelcomeBanner(): BrandBanner {
  const attachmentName = 'blackcat-welcome.png';
  return {
    attachmentName,
    path: fileURLToPath(new URL('../../api/assets/onboarding/welcome.png', import.meta.url)),
    url: `attachment://${attachmentName}`
  };
}
