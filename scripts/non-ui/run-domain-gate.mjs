import { spawn } from 'node:child_process';
import process from 'node:process';

const gate = process.argv[2];
const filesByGate = {
  a0: ['tests/non-ui/nui-a0-harness.spec.ts'],
  a1: [
    'tests/non-ui/nui-a0-harness.spec.ts',
    'tests/non-ui/account-wallet-contract.spec.ts',
    'tests/non-ui/account-wallet.spec.ts'
  ],
  a2: [
    'tests/non-ui/nui-a0-harness.spec.ts',
    'tests/non-ui/account-wallet-contract.spec.ts',
    'tests/non-ui/account-wallet.spec.ts',
    'tests/non-ui/catalog-player.spec.ts'
  ],
  a3: [
    'tests/non-ui/nui-a0-harness.spec.ts',
    'tests/non-ui/account-wallet-contract.spec.ts',
    'tests/non-ui/account-wallet.spec.ts',
    'tests/non-ui/catalog-player.spec.ts',
    'tests/non-ui/order-gift-concurrency.spec.ts',
    'tests/m1-us-03-api.spec.ts',
    'tests/m1-us-03-db.spec.ts',
    'tests/m1-us-04-bot.spec.ts',
    'tests/m2-us-04-api.spec.ts',
    'tests/m10-us-04-postgres.spec.ts',
    'tests/m10-us-07-order-requirements.spec.ts',
    'tests/m10-us-08-service-packages-postgres.spec.ts',
    'tests/m10-us-09-game-scoped-ordering-api.spec.ts',
    'tests/m11-us-02-selection-pools-api.spec.ts',
    'tests/m11-us-02-selection-pools-postgres.spec.ts',
    'tests/m11-us-03-selection-discord.spec.ts',
    'tests/m11-us-06-selection-reactions.spec.ts',
    'tests/m12-us-03-worker.spec.ts',
    'tests/m16-us-02-api-resilience.spec.ts'
  ],
  a4: [
    'tests/non-ui/nui-a0-harness.spec.ts',
    'tests/non-ui/account-wallet-contract.spec.ts',
    'tests/non-ui/account-wallet.spec.ts',
    'tests/non-ui/catalog-player.spec.ts',
    'tests/non-ui/order-gift-concurrency.spec.ts',
    'tests/m1-us-03-api.spec.ts',
    'tests/m1-us-03-db.spec.ts',
    'tests/m1-us-04-bot.spec.ts',
    'tests/m2-us-04-api.spec.ts',
    'tests/m10-us-04-postgres.spec.ts',
    'tests/m10-us-07-order-requirements.spec.ts',
    'tests/m10-us-08-service-packages-postgres.spec.ts',
    'tests/m10-us-09-game-scoped-ordering-api.spec.ts',
    'tests/m11-us-02-selection-pools-api.spec.ts',
    'tests/m11-us-02-selection-pools-postgres.spec.ts',
    'tests/m11-us-03-selection-discord.spec.ts',
    'tests/m11-us-06-selection-reactions.spec.ts',
    'tests/m12-us-03-worker.spec.ts',
    'tests/m16-us-02-api-resilience.spec.ts',
    'tests/m2-us-05-db.spec.ts',
    'tests/m2-us-10-api.spec.ts',
    'tests/m2-us-10-db.spec.ts',
    'tests/m2-us-11-api.spec.ts',
    'tests/m2-us-11-worker.spec.ts',
    'tests/m4-us-02-api.spec.ts',
    'tests/m10-us-03-postgres.spec.ts',
    'tests/m12-us-02-api.spec.ts',
    'tests/m12-us-03-postgres.spec.ts',
    'tests/m14-us-02-support-triage-api.spec.ts',
    'tests/m15-us-03-order-transcript.spec.ts',
    'tests/api-review-approval-runtime.spec.ts',
    'tests/api-review-refund-integrity-db.spec.ts'
  ],
  a5: [
    'tests/non-ui/nui-a0-harness.spec.ts',
    'tests/non-ui/account-wallet-contract.spec.ts',
    'tests/non-ui/account-wallet.spec.ts',
    'tests/non-ui/catalog-player.spec.ts',
    'tests/non-ui/order-gift-concurrency.spec.ts',
    'tests/m1-us-03-api.spec.ts',
    'tests/m1-us-03-db.spec.ts',
    'tests/m1-us-04-bot.spec.ts',
    'tests/m2-us-04-api.spec.ts',
    'tests/m10-us-04-postgres.spec.ts',
    'tests/m10-us-07-order-requirements.spec.ts',
    'tests/m10-us-08-service-packages-postgres.spec.ts',
    'tests/m10-us-09-game-scoped-ordering-api.spec.ts',
    'tests/m11-us-02-selection-pools-api.spec.ts',
    'tests/m11-us-02-selection-pools-postgres.spec.ts',
    'tests/m11-us-03-selection-discord.spec.ts',
    'tests/m11-us-06-selection-reactions.spec.ts',
    'tests/m12-us-03-worker.spec.ts',
    'tests/m16-us-02-api-resilience.spec.ts',
    'tests/m2-us-05-db.spec.ts',
    'tests/m2-us-10-api.spec.ts',
    'tests/m2-us-10-db.spec.ts',
    'tests/m2-us-11-api.spec.ts',
    'tests/m2-us-11-worker.spec.ts',
    'tests/m4-us-02-api.spec.ts',
    'tests/m10-us-03-postgres.spec.ts',
    'tests/m12-us-02-api.spec.ts',
    'tests/m12-us-03-postgres.spec.ts',
    'tests/m14-us-02-support-triage-api.spec.ts',
    'tests/m15-us-03-order-transcript.spec.ts',
    'tests/api-review-approval-runtime.spec.ts',
    'tests/api-review-refund-integrity-db.spec.ts',
    'tests/m3-us-04-api.spec.ts',
    'tests/m3-us-04-db.spec.ts',
    'tests/m3-us-05-api.spec.ts',
    'tests/m3-us-05-commissions-api.spec.ts',
    'tests/m3-us-05-db.spec.ts',
    'tests/m3-us-07-api.spec.ts',
    'tests/m3-us-07-db.spec.ts',
    'tests/m4-us-08-api.spec.ts'
  ]
};

const files = filesByGate[gate];
if (!files) {
  throw new Error(`Unknown non-UI gate '${gate ?? ''}'. Available gates: ${Object.keys(filesByGate).join(', ')}`);
}

await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['./node_modules/vitest/vitest.mjs', 'run', ...files], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'test' },
    stdio: 'inherit'
  });
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    if (signal) reject(new Error(`Non-UI gate ${gate} terminated by ${signal}.`));
    else if (code === 0) resolve();
    else reject(new Error(`Non-UI gate ${gate} failed with exit code ${code}.`));
  });
});
