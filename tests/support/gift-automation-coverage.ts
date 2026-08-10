export interface GiftAutomationCoverage {
  id: `GTA-${'S' | 'O' | 'A' | 'L' | 'B'}-${string}`;
  sources: Array<{ file: `tests/${string}.spec.ts`; test: string }>;
}

const source = (file: `tests/${string}.spec.ts`, test: string) => ({ file, test });

export const giftAutomationCoverage: GiftAutomationCoverage[] = [
  { id: 'GTA-S-001', sources: [source('tests/m22-us-06-gift-entry-postgres.spec.ts', 'lists a trusted recipient')] },
  { id: 'GTA-S-002', sources: [source('tests/m22-us-06-gift-entry-postgres.spec.ts', 'persists one idempotent public request')] },
  { id: 'GTA-S-003', sources: [source('tests/m22-us-02-standalone-gift-api.spec.ts', 'creates one order-independent anonymous request')] },
  { id: 'GTA-S-004', sources: [source('tests/m22-us-06-gift-entry-postgres.spec.ts', 'insufficient and stale-catalog submissions')] },
  { id: 'GTA-S-005', sources: [source('tests/m22-us-02-standalone-gift-api.spec.ts', 'refreshes after funding')] },
  { id: 'GTA-S-006', sources: [source('tests/m22-us-06-gift-entry-postgres.spec.ts', 'insufficient and stale-catalog submissions')] },
  { id: 'GTA-S-007', sources: [source('tests/m22-us-06-gift-entry-postgres.spec.ts', 'serializes two independent confirmations')] },
  { id: 'GTA-S-008', sources: [source('tests/m22-us-06-gift-entry-postgres.spec.ts', 'lists a trusted recipient')] },
  { id: 'GTA-S-009', sources: [source('tests/m22-us-06-gift-entry-postgres.spec.ts', 'persists one idempotent public request'), source('tests/m22-us-06-gift-entry-postgres.spec.ts', 'different idempotency key')] },

  { id: 'GTA-O-001', sources: [source('tests/m6-us-06-api.spec.ts', 'permits order gifts')] },
  { id: 'GTA-O-002', sources: [source('tests/m6-us-06-api.spec.ts', 'rejects order gifts outside'), source('tests/m6-us-06-api.spec.ts', 'same customer order in another Guild')] },
  { id: 'GTA-O-003', sources: [source('tests/m6-us-06-api.spec.ts', 'one atomic gift fact per each')] },
  { id: 'GTA-O-004', sources: [source('tests/m6-us-06-api.spec.ts', 'one selected participant is invalid'), source('tests/m10-us-05-postgres.spec.ts', 'rolls the entire batch back')] },
  { id: 'GTA-O-005', sources: [source('tests/m6-us-06-api.spec.ts', 'one selected participant is invalid')] },
  { id: 'GTA-O-006', sources: [source('tests/m6-us-06-api.spec.ts', 'requires reconfirmation after price/status/version change'), source('tests/m6-us-06-api.spec.ts', 'another active reservation wins the race')] },
  { id: 'GTA-O-007', sources: [source('tests/m6-us-06-api.spec.ts', 'replays the same order-gift intent')] },
  { id: 'GTA-O-008', sources: [source('tests/m6-us-06-api.spec.ts', 'rejects anonymous order-gift input')] },

  { id: 'GTA-A-001', sources: [source('tests/m22-us-04-staff-gift-assist-api.spec.ts', 'rejects consumed challenge replay')] },
  { id: 'GTA-A-002', sources: [source('tests/m22-us-04-staff-gift-assist-postgres.spec.ts', 'atomically consumes the challenge')] },
  { id: 'GTA-A-003', sources: [source('tests/m22-us-06-gift-assist-boundaries.spec.ts', 'denies unresolved staff')] },
  { id: 'GTA-A-004', sources: [source('tests/m22-us-06-gift-assist-boundaries.spec.ts', 'rejects an unbound customer'), source('tests/m22-us-04-staff-gift-assist-bot.spec.ts', 'derives the payer from the target message author')] },
  { id: 'GTA-A-005', sources: [source('tests/m22-us-04-staff-gift-assist-postgres.spec.ts', 'increments a bad proof')] },
  { id: 'GTA-A-006', sources: [source('tests/m22-us-06-gift-assist-boundaries.spec.ts', 'locks the challenge after five')] },
  { id: 'GTA-A-007', sources: [source('tests/m22-us-06-gift-assist-boundaries.spec.ts', 'rejects an expired challenge')] },
  { id: 'GTA-A-008', sources: [source('tests/m22-us-04-staff-gift-assist-api.spec.ts', 'permission version changes')] },
  { id: 'GTA-A-009', sources: [source('tests/m22-us-04-staff-gift-assist-api.spec.ts', 'refreshes the bound customer wallet')] },
  { id: 'GTA-A-010', sources: [source('tests/m22-us-06-gift-assist-boundaries.spec.ts', 'under concurrent confirmations'), source('tests/m22-us-04-staff-gift-assist-postgres.spec.ts', 'reserves the bound customer balance once')] },
  { id: 'GTA-A-011', sources: [source('tests/m22-us-06-gift-assist-boundaries.spec.ts', 'never stores or returns the successful TOTP'), source('tests/m22-us-04-staff-gift-assist-bot.spec.ts', 'never reads message content')] },

  { id: 'GTA-L-001', sources: [source('tests/m22-us-06-gift-lifecycle-postgres.spec.ts', 'verifies and approves'), source('tests/m6-us-06-api.spec.ts', 'creates every gift fact atomically'), source('tests/m22-us-04-staff-gift-assist-postgres.spec.ts', 'atomically consumes the challenge')] },
  { id: 'GTA-L-002', sources: [source('tests/m3-us-02-api.spec.ts', 'blocks L1 from approval')] },
  { id: 'GTA-L-003', sources: [source('tests/m3-us-02-api.spec.ts', 'L2 at exactly 200000'), source('tests/m3-us-02-api.spec.ts', 'L3 amount boundary'), source('tests/m3-us-02-api.spec.ts', 'routes 500000 to L4')] },
  { id: 'GTA-L-004', sources: [source('tests/m22-us-06-gift-lifecycle-postgres.spec.ts', 'capturing the original reservation exactly once')] },
  { id: 'GTA-L-005', sources: [source('tests/m3-us-02-api.spec.ts', 'resumes the same internal wallet debit'), source('tests/m3-us-02-db.spec.ts', 'rolls back authorization, capture, wallet facts')] },
  { id: 'GTA-L-006', sources: [source('tests/m22-us-06-gift-lifecycle-postgres.spec.ts', 'releasing its reservation without charge')] },
  { id: 'GTA-L-007', sources: [source('tests/m3-us-06-api.spec.ts', 'only the sender withdraw before capture')] },
  { id: 'GTA-L-008', sources: [source('tests/m22-us-06-gift-lifecycle-postgres.spec.ts', 'expires through the real Worker handler')] },
  { id: 'GTA-L-009', sources: [source('tests/m22-us-06-gift-lifecycle-postgres.spec.ts', 'capturing the original reservation exactly once')] },
  { id: 'GTA-L-010', sources: [source('tests/m22-us-06-gift-lifecycle-postgres.spec.ts', 'concurrent approve and reject')] },
  { id: 'GTA-L-011', sources: [source('tests/m22-us-06-gift-privacy-worker.spec.ts', 'retries Discord delivery')] },
  { id: 'GTA-L-012', sources: [source('tests/m22-us-06-gift-privacy-worker.spec.ts', 'retries Discord delivery')] },

  { id: 'GTA-B-001', sources: [source('tests/m22-us-03-bot-gift-entry.spec.ts', 'routes real Sapphire buttons/selects'), source('tests/m22-us-04-staff-gift-assist-bot.spec.ts', 'three dedicated Sapphire handlers'), source('tests/m20-us-06-gift-component-protocol.spec.ts', 'real affordability renderer')] },
  { id: 'GTA-B-002', sources: [source('tests/m22-us-06-gift-bot-adapter.spec.ts', 'shared entry public and all personal gift facts ephemeral')] },
  { id: 'GTA-B-003', sources: [source('tests/m22-us-06-gift-bot-adapter.spec.ts', 'rejects tampering, expiry and actor switching')] },
  { id: 'GTA-B-004', sources: [source('tests/m22-us-06-gift-bot-adapter.spec.ts', 'surviving a fresh decoder instance')] },
  { id: 'GTA-B-005', sources: [source('tests/m22-us-03-bot-gift-entry.spec.ts', 'reconciles one pinned managed card'), source('tests/m22-us-03-bot-gift-entry.spec.ts', 'recreates a deleted projected card')] },
  { id: 'GTA-B-006', sources: [source('tests/m22-us-06-gift-privacy-worker.spec.ts', 'immutable snapshot')] },
  { id: 'GTA-B-007', sources: [source('tests/m22-us-06-gift-privacy-worker.spec.ts', 'immutable snapshot')] },
  { id: 'GTA-B-008', sources: [source('tests/m22-us-06-gift-privacy-worker.spec.ts', 'retries Discord delivery')] }
];
