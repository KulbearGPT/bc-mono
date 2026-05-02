import { buildDashboardManifest } from './manifest.js';

export function App() {
  const manifest = buildDashboardManifest();

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24 }}>
      <h1>{manifest.appName}</h1>
      <p>P0 dashboard shell is ready. Operational modules are delivered by later stories.</p>
    </main>
  );
}
