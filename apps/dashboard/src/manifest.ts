export function buildDashboardManifest() {
  return {
    appName: 'Blackcat Companion Dashboard',
    framework: 'react-vite',
    routes: [{ path: '/', label: 'Operations home' }]
  } as const;
}
