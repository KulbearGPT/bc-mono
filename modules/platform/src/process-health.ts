import { createServer, type Server } from 'node:http';

export type ProductionService = 'bot' | 'worker';

export function startProcessHealthServer(input: {
  port: number;
  isReady: () => boolean;
}): Promise<{ server: Server; close: () => Promise<void> }> {
  if (!Number.isSafeInteger(input.port) || input.port < 0 || input.port > 65_535) {
    throw new Error('PORT must be an integer between 0 and 65535.');
  }
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/health') {
      response.writeHead(404).end();
      return;
    }
    const ready = input.isReady();
    response.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: ready ? 'ok' : 'starting' }));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(input.port, '0.0.0.0', () => resolve({
      server,
      close: () => new Promise<void>((done, failed) => server.close((error) => error ? failed(error) : done()))
    }));
  });
}

export function requireProductionServiceEnv(service: ProductionService, env: NodeJS.ProcessEnv | Record<string, string | undefined>): void {
  const required = service === 'bot'
    ? ['PORT', 'DISCORD_BOT_TOKEN', 'API_BASE_URL', 'BOT_SERVICE_TOKEN']
    : ['PORT', 'DATABASE_URL', 'DISCORD_BOT_TOKEN', 'API_BASE_URL', 'BOT_SERVICE_TOKEN'];
  const missing = required.filter((key) => !env[key]?.trim());
  if (env.NODE_ENV !== 'production') missing.unshift('NODE_ENV=production');
  if (missing.length) throw new Error(`${service} production configuration is missing: ${missing.join(', ')}`);
  if (!isAllowedServiceApiBaseUrl(env.API_BASE_URL!)) {
    throw new Error('API_BASE_URL must use HTTPS or Railway private HTTP.');
  }
  processHealthPort(env.PORT);
}

export function processHealthPort(value: string | undefined): number {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('PORT must be an integer between 1 and 65535.');
  return port;
}

function isAllowedServiceApiBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname.endsWith('.railway.internal'));
  } catch {
    return false;
  }
}
