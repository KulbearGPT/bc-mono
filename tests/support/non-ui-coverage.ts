export type NonUiPackage = `NUI-A${0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`;
export type NonUiCoverageStatus = 'PLANNED' | 'AUTOMATED';
export type NonUiAcceptanceClass =
  'AUTOMATED_FULL' | 'AUTOMATED_PARTIAL_EXTERNAL_REMAINS' | 'EXTERNAL_ONLY' | 'OUT_OF_SCOPE_GIFT';

export interface NonUiAutomationCase {
  automationId: `BNUI-${string}`;
  implementationPackage: NonUiPackage;
  acceptanceIds: `AT-${string}`[];
  acceptanceClass: NonUiAcceptanceClass;
  status: NonUiCoverageStatus;
  sources: Array<{ file: `tests/${string}.spec.ts`; test: string }>;
}

const planned = (implementationPackage: NonUiPackage, automationId: `BNUI-${string}`): NonUiAutomationCase => ({
  automationId,
  implementationPackage,
  acceptanceIds: [],
  acceptanceClass: 'AUTOMATED_PARTIAL_EXTERNAL_REMAINS',
  status: 'PLANNED',
  sources: []
});

const automated = (
  automationId: `BNUI-${string}`,
  acceptanceIds: `AT-${string}`[],
  test: string,
  acceptanceClass: NonUiAcceptanceClass = 'AUTOMATED_FULL'
): NonUiAutomationCase => ({
  automationId,
  implementationPackage: 'NUI-A1',
  acceptanceIds,
  acceptanceClass,
  status: 'AUTOMATED',
  sources: [{ file: 'tests/non-ui/account-wallet.spec.ts', test }]
});

const automatedA2 = (
  automationId: `BNUI-${string}`,
  acceptanceIds: `AT-${string}`[],
  test: string,
  acceptanceClass: NonUiAcceptanceClass = 'AUTOMATED_FULL'
): NonUiAutomationCase => ({
  automationId,
  implementationPackage: 'NUI-A2',
  acceptanceIds,
  acceptanceClass,
  status: 'AUTOMATED',
  sources: [{ file: 'tests/non-ui/catalog-player.spec.ts', test }]
});

const automatedA3 = (
  automationId: `BNUI-${string}`,
  acceptanceIds: `AT-${string}`[],
  sources: NonUiAutomationCase['sources'],
  acceptanceClass: NonUiAcceptanceClass = 'AUTOMATED_FULL'
): NonUiAutomationCase => ({
  automationId,
  implementationPackage: 'NUI-A3',
  acceptanceIds,
  acceptanceClass,
  status: 'AUTOMATED',
  sources
});

const automatedA4 = (
  automationId: `BNUI-${string}`,
  acceptanceIds: `AT-${string}`[],
  sources: NonUiAutomationCase['sources'],
  acceptanceClass: NonUiAcceptanceClass = 'AUTOMATED_FULL'
): NonUiAutomationCase => ({
  automationId,
  implementationPackage: 'NUI-A4',
  acceptanceIds,
  acceptanceClass,
  status: 'AUTOMATED',
  sources
});

export const nonUiAutomationCoverage: NonUiAutomationCase[] = [
  automated(
    'BNUI-ACC-001',
    ['AT-ACC-001', 'AT-ACC-003', 'AT-ONB-001', 'AT-ONB-006'],
    'BNUI-ACC-001 registers one trusted Discord account, CAT wallet and role task with idempotent audit',
    'AUTOMATED_PARTIAL_EXTERNAL_REMAINS'
  ),
  automated(
    'BNUI-ACC-002',
    ['AT-ONB-002', 'AT-ONB-006'],
    'BNUI-ACC-002 creates one pending companion application and rejects an untrusted source with zero writes'
  ),
  automated(
    'BNUI-ACC-003',
    ['AT-ACC-002', 'AT-ACC-004', 'AT-PRF-002', 'AT-PRF-004', 'AT-PRF-006'],
    'BNUI-ACC-003 keeps current-user profile and paginated orders private to the trusted Guild actor',
    'AUTOMATED_PARTIAL_EXTERNAL_REMAINS'
  ),
  automated(
    'BNUI-WLT-001',
    ['AT-PL-002', 'AT-WAL-001', 'AT-PRF-006'],
    'BNUI-WLT-001 calculates one CAT balance from append-only entries and active order plus gift reservations'
  ),
  automated(
    'BNUI-WLT-002',
    ['AT-WAL-003', 'AT-WAL-005', 'AT-WAL-006', 'AT-WAL-007', 'AT-WLT-011'],
    'BNUI-WLT-002 credits USD cents as CAT once, rejects duplicate receipts and exposes only paginated public entries',
    'AUTOMATED_PARTIAL_EXTERNAL_REMAINS'
  ),
  automated(
    'BNUI-WLT-003',
    ['AT-WAL-004', 'AT-WLT-012', 'AT-WLT-013'],
    'BNUI-WLT-003 denies L1, stale step-up and invalid top-up input without wallet business writes'
  ),
  automated(
    'BNUI-WLT-004',
    ['AT-WAL-002', 'AT-WAL-008', 'AT-WAL-009', 'AT-CAT-004'],
    'BNUI-WLT-004 rejects an overdrawn offline refund then appends one valid non-negative debit and audit'
  ),
  automated(
    'BNUI-WLT-005',
    ['AT-PL-002', 'AT-WAL-006'],
    'BNUI-WLT-005 converges a lost-response replay and concurrent refund race to one credit and one debit'
  ),
  automated(
    'BNUI-WLT-006',
    ['AT-WAL-010', 'AT-WHK-001', 'AT-WHK-002', 'AT-WHK-003', 'AT-CAT-005'],
    'BNUI-WLT-006 keeps payment providers and webhooks retired with unknown routes and zero business writes',
    'AUTOMATED_PARTIAL_EXTERNAL_REMAINS'
  ),
  automatedA2(
    'BNUI-CAT-001',
    ['AT-CAT-001', 'AT-CAT-002', 'AT-ARC-001'],
    'BNUI-CAT-001 creates, supersedes and archives immutable CAT service versions without rewriting an order snapshot'
  ),
  automatedA2(
    'BNUI-CAT-002',
    ['AT-CAT-001', 'AT-TAG-002'],
    'BNUI-CAT-002 rejects missing prices, invalid units and wrong tag types with zero catalog, audit or outbox writes'
  ),
  automatedA2(
    'BNUI-PKG-001',
    ['AT-MULTI-012', 'AT-MULTI-014'],
    'BNUI-PKG-001 publishes ordered same-game slots with a server-derived total and one immutable active version per code'
  ),
  automatedA2(
    'BNUI-PKG-002',
    ['AT-MULTI-012', 'AT-MULTI-014'],
    'BNUI-PKG-002 rejects mixed-game slots and lets only one concurrent activation of the same draft succeed'
  ),
  automatedA2(
    'BNUI-TAG-001',
    ['AT-TAG-001', 'AT-TAG-004'],
    'BNUI-TAG-001 keeps tag codes and historical references stable while disabling only future selection'
  ),
  automatedA2(
    'BNUI-PLY-001',
    ['AT-ONB-005', 'AT-TAG-002'],
    'BNUI-PLY-001 approves and rejects companion applications atomically with version, tags, role tasks and audit',
    'AUTOMATED_PARTIAL_EXTERNAL_REMAINS'
  ),
  automatedA2(
    'BNUI-PLY-002',
    ['AT-DOP-005'],
    'BNUI-PLY-002 excludes a paused player from new candidates, restores them, and leaves an existing order fact unchanged',
    'AUTOMATED_PARTIAL_EXTERNAL_REMAINS'
  ),
  automatedA2(
    'BNUI-PLY-003',
    ['AT-COMP-001', 'AT-COMP-002'],
    'BNUI-PLY-003 validates batch compensation and freezes the selected rule into the participant snapshot'
  ),
  automatedA3(
    'BNUI-ORD-001',
    ['AT-CAT-003', 'AT-MULTI-006', 'AT-PL-001'],
    [
      {
        file: 'tests/m10-us-07-order-requirements.spec.ts',
        test: 'derives every line and order estimate without accepting client money'
      }
    ],
    'AUTOMATED_PARTIAL_EXTERNAL_REMAINS'
  ),
  automatedA3(
    'BNUI-ORD-002',
    ['AT-MULTI-008', 'AT-MULTI-009', 'AT-MULTI-011', 'AT-MULTI-013'],
    [
      {
        file: 'tests/m10-us-08-service-packages-postgres.spec.ts',
        test: 'replaces the basket with independent slots, notes, events, package price and audit atomically'
      },
      {
        file: 'tests/m10-us-09-game-scoped-ordering-api.spec.ts',
        test: 'allows another game as a separate single item while preserving same-game slot replacement'
      }
    ],
    'AUTOMATED_PARTIAL_EXTERNAL_REMAINS'
  ),
  automatedA3(
    'BNUI-ORD-003',
    ['AT-ORD-001', 'AT-RES-001'],
    [
      {
        file: 'tests/m1-us-03-db.spec.ts',
        test: 'uses the remaining amount of a partially settled hold when submitting another order'
      }
    ],
    'AUTOMATED_PARTIAL_EXTERNAL_REMAINS'
  ),
  automatedA3(
    'BNUI-ORD-004',
    ['AT-ORD-002', 'AT-RES-003'],
    [
      {
        file: 'tests/non-ui/order-gift-concurrency.spec.ts',
        test: 'BNUI-ORD-004 serializes order and gift reservations against one exact CAT balance'
      }
    ]
  ),
  automatedA3(
    'BNUI-ORD-005',
    ['AT-ORD-003', 'AT-ORD-004', 'AT-REV-004'],
    [
      {
        file: 'tests/m16-us-02-api-resilience.spec.ts',
        test: 'terminalizes the committed response when normal idempotency completion fails'
      },
      {
        file: 'tests/m1-us-04-bot.spec.ts',
        test: 'create order returns existing active channel without planning a second submittable order'
      }
    ],
    'AUTOMATED_PARTIAL_EXTERNAL_REMAINS'
  ),
  automatedA3(
    'BNUI-ORD-006',
    ['AT-CAT-002', 'AT-ORD-002'],
    [
      {
        file: 'tests/m1-us-03-api.spec.ts',
        test: 'updateOrder rejects stale expectedVersion and inactive catalog versions'
      },
      {
        file: 'tests/m10-us-08-service-packages-postgres.spec.ts',
        test: 'rolls every generated slot, event and order change back when audit append fails'
      }
    ]
  ),
  automatedA3(
    'BNUI-ORD-007',
    ['AT-CHN-001', 'AT-CHN-003', 'AT-PRJ-001'],
    [
      {
        file: 'tests/m1-us-04-bot.spec.ts',
        test: 'create order maps channel creation failure to a non-submittable recovery result'
      },
      {
        file: 'tests/m1-us-04-bot.spec.ts',
        test: 'channel failure reporting retries once and keeps a deterministic support request id'
      }
    ],
    'AUTOMATED_PARTIAL_EXTERNAL_REMAINS'
  ),
  automatedA3(
    'BNUI-ORD-008',
    ['AT-MULTI-006', 'AT-SEL-008'],
    [
      {
        file: 'tests/m11-us-06-selection-reactions.spec.ts',
        test: 'renders one reaction-only card for one through nine requirements and rejects ten'
      },
      {
        file: 'tests/m11-us-06-selection-reactions.spec.ts',
        test: 'rejects starting a round with ten remaining requirement rows before any pool write'
      }
    ],
    'AUTOMATED_PARTIAL_EXTERNAL_REMAINS'
  ),
  automatedA3(
    'BNUI-SEL-001',
    ['AT-SEL-001', 'AT-DSP-002', 'AT-DSP-011', 'AT-DSP-012', 'AT-DSP-015', 'AT-DSP-016'],
    [
      {
        file: 'tests/m11-us-02-selection-pools-api.spec.ts',
        test: 'accepts an application long after recruitment started until the customer stops it'
      },
      {
        file: 'tests/m11-us-02-selection-pools-postgres.spec.ts',
        test: 'does not close a pool when a legacy deadline worker call is recovered'
      }
    ],
    'AUTOMATED_PARTIAL_EXTERNAL_REMAINS'
  ),
  automatedA3(
    'BNUI-SEL-002',
    ['AT-DSP-001', 'AT-DSP-003', 'AT-SEL-002', 'AT-SEL-007', 'AT-SEL-008'],
    [
      {
        file: 'tests/m11-us-02-selection-pools-postgres.spec.ts',
        test: 'persists a reaction card and reactivates the same application after reaction removal'
      },
      {
        file: 'tests/m11-us-06-selection-reactions.spec.ts',
        test: 'serializes rapid add then remove events for the same user and project'
      }
    ],
    'AUTOMATED_PARTIAL_EXTERNAL_REMAINS'
  ),
  automatedA3(
    'BNUI-SEL-003',
    ['AT-DSP-004', 'AT-SEL-004'],
    [
      {
        file: 'tests/m11-us-02-selection-pools-postgres.spec.ts',
        test: 'allows cross-order applications while offline, then atomically grants only one active slot'
      }
    ]
  ),
  automatedA3(
    'BNUI-SEL-004',
    ['AT-DSP-014', 'AT-MULTI-007', 'AT-SEL-004', 'AT-SEL-005'],
    [
      {
        file: 'tests/m11-us-02-selection-pools-api.spec.ts',
        test: 'closes early and atomically selects multiple applicants while retaining partial selections'
      },
      {
        file: 'tests/m11-us-02-selection-pools-api.spec.ts',
        test: 'lets the owner explicitly start a new round after an empty selection without touching the reservation'
      }
    ],
    'AUTOMATED_PARTIAL_EXTERNAL_REMAINS'
  ),
  automatedA3(
    'BNUI-SEL-005',
    ['AT-SEL-003', 'AT-SEL-006', 'AT-DSP-019', 'AT-DSP-020'],
    [
      {
        file: 'tests/m11-us-03-selection-discord.spec.ts',
        test: 'uses Discord REST idempotently with user_limit zero and explicit loser cleanup'
      },
      {
        file: 'tests/m11-us-03-selection-discord.spec.ts',
        test: 'creates one recovery task only on the terminal Discord sync attempt'
      }
    ],
    'AUTOMATED_PARTIAL_EXTERNAL_REMAINS'
  ),
  automatedA3(
    'BNUI-RDY-001',
    ['AT-RDY-001', 'AT-SVC-001'],
    [
      {
        file: 'tests/m2-us-04-api.spec.ts',
        test: 'setOrderReadiness rejects customers and starts only from the active participant fact'
      }
    ]
  ),
  automatedA3(
    'BNUI-RDY-002',
    ['AT-RDY-002', 'AT-RDY-003', 'AT-MULTI-003', 'AT-STATE-001'],
    [
      {
        file: 'tests/m10-us-04-postgres.spec.ts',
        test: 'starts from all active participant facts without writing customer readiness'
      }
    ]
  ),
  automatedA3(
    'BNUI-RDY-003',
    ['AT-RDY-003', 'AT-RDY-005', 'AT-STATE-001'],
    [
      { file: 'tests/m2-us-04-api.spec.ts', test: 'legacy single-party start endpoint is rejected and audited' },
      {
        file: 'tests/m10-us-04-postgres.spec.ts',
        test: 'database guard rejects legacy aggregate timestamps when an active participant is still unready'
      }
    ]
  ),
  automatedA3(
    'BNUI-SVC-001',
    ['AT-SVC-002', 'AT-SVC-003', 'AT-MULTI-004'],
    [
      {
        file: 'tests/m10-us-04-postgres.spec.ts',
        test: 'blocks an unready late player, then captures the latest total into nine participant earnings'
      },
      {
        file: 'tests/m2-us-04-api.spec.ts',
        test: 'customer confirm completion records consumption, player earning and eligible referral commission facts'
      }
    ],
    'AUTOMATED_PARTIAL_EXTERNAL_REMAINS'
  ),
  automatedA3(
    'BNUI-SVC-002',
    ['AT-SVC-004', 'AT-RDY-004'],
    [
      {
        file: 'tests/m2-us-04-api.spec.ts',
        test: 'completion confirmation timeout creates exactly one staff review task without settling money'
      },
      {
        file: 'tests/m12-us-03-worker.spec.ts',
        test: 'reminder sends once while pending and overdue changes facts without punishment'
      }
    ]
  ),
  automatedA4(
    'BNUI-CXL-001',
    ['AT-CXL-001', 'AT-CXL-002', 'AT-CXL-003', 'AT-CXL-004'],
    [
      {
        file: 'tests/m2-us-10-api.spec.ts',
        test: 'previews an automatic reservation release without mutating order or funds'
      },
      {
        file: 'tests/m2-us-10-api.spec.ts',
        test: 'rejects a stale preview after the order changes and leaves reservation untouched'
      }
    ]
  ),
  automatedA4(
    'BNUI-CXL-002',
    ['AT-CAN-001', 'AT-CAN-002', 'AT-CAN-004', 'AT-CAN-007', 'AT-CAN-008'],
    [
      { file: 'tests/m2-us-10-db.spec.ts', test: 'applies the matching preview and releases reservation atomically' },
      {
        file: 'tests/api-review-refund-integrity-db.spec.ts',
        test: 'approves the immutable refund snapshot and commits decision, refund, wallet credit, and audit atomically'
      }
    ],
    'AUTOMATED_PARTIAL_EXTERNAL_REMAINS'
  ),
  automatedA4(
    'BNUI-CXL-003',
    ['AT-CAN-003', 'AT-CAN-009', 'AT-SUP-003'],
    [
      {
        file: 'tests/api-review-refund-integrity-db.spec.ts',
        test: 'rolls back the approval decision and all refund facts when the success audit cannot be appended'
      },
      {
        file: 'tests/api-review-refund-integrity-db.spec.ts',
        test: 'serializes different idempotency keys and never credits more than the captured charge'
      }
    ]
  ),
  automatedA4(
    'BNUI-ORD-009',
    ['AT-MULTI-010', 'AT-MULTI-015'],
    [
      {
        file: 'tests/m10-us-03-postgres.spec.ts',
        test: 'reassigns one persisted participant without changing the other line, total, or reservation facts'
      },
      {
        file: 'tests/m10-us-03-postgres.spec.ts',
        test: 'AT-MULTI-015 persists staff note corrections without changing funds and rejects terminal recovery writes'
      }
    ]
  ),
  automatedA4(
    'BNUI-SUP-001',
    ['AT-SUP-001'],
    [
      {
        file: 'tests/m2-us-05-db.spec.ts',
        test: 'claimStaffTask is atomic: concurrent L1 claims leave exactly one claimant'
      }
    ]
  ),
  automatedA4(
    'BNUI-SUP-002',
    ['AT-SUP-002', 'AT-RBAC-001', 'AT-RBAC-002'],
    [
      { file: 'tests/m4-us-02-api.spec.ts', test: 'lets L1 append a note and escalate only a personally claimed task' },
      { file: 'tests/m2-us-11-api.spec.ts', test: 'lets only L2 resolve a claimed task after automation resumes' }
    ],
    'AUTOMATED_PARTIAL_EXTERNAL_REMAINS'
  ),
  automatedA4(
    'BNUI-SUP-003',
    ['AT-SUP-005', 'AT-SUP-006'],
    [
      {
        file: 'tests/m2-us-11-api.spec.ts',
        test: 'lets L1 pause only an order task they claimed without changing its reservation'
      },
      {
        file: 'tests/m2-us-11-worker.spec.ts',
        test: 'skips readiness timeout escalation while lifecycle automation is paused'
      }
    ],
    'AUTOMATED_PARTIAL_EXTERNAL_REMAINS'
  ),
  automatedA4(
    'BNUI-SUP-004',
    ['AT-SUP-011'],
    [
      {
        file: 'tests/m12-us-03-postgres.spec.ts',
        test: 'two staff replies serialize to one owner while both response facts converge'
      },
      {
        file: 'tests/m12-us-03-worker.spec.ts',
        test: 'L4 first response claims oldest OPEN task and later staff cannot steal it'
      }
    ],
    'AUTOMATED_PARTIAL_EXTERNAL_REMAINS'
  ),
  automatedA4(
    'BNUI-SUP-005',
    ['AT-SUP-010', 'AT-SUP-013'],
    [
      { file: 'tests/m12-us-02-api.spec.ts', test: 'L1 clock-in is idempotent and current shift is queryable' },
      { file: 'tests/m12-us-02-api.spec.ts', test: 'L1 summary is self-only while L2 sees ACTIVE L1-L4 support actors' }
    ],
    'AUTOMATED_PARTIAL_EXTERNAL_REMAINS'
  ),
  automatedA4(
    'BNUI-SUP-006',
    ['AT-DOP-002', 'AT-SUX-002', 'AT-SUX-003', 'AT-SUX-004'],
    [
      {
        file: 'tests/m15-us-03-order-transcript.spec.ts',
        test: 'returns immutable lifecycle events with stable cursor pages and deletion metadata'
      },
      {
        file: 'tests/m15-us-03-order-transcript.spec.ts',
        test: 'renders a read-only transcript without any message mutation controls'
      },
      {
        file: 'tests/m14-us-02-support-triage-api.spec.ts',
        test: 'never emits malformed links and hides a task carrying another Guild context'
      }
    ],
    'AUTOMATED_PARTIAL_EXTERNAL_REMAINS'
  ),
  automatedA4(
    'BNUI-APR-001',
    ['AT-RBAC-003', 'AT-RBAC-004', 'AT-RBAC-005', 'AT-RBAC-006', 'AT-AUD-001'],
    [
      {
        file: 'tests/api-review-approval-runtime.spec.ts',
        test: 'fails closed for stale, expired, cross-Guild, and reserved actions'
      },
      {
        file: 'tests/api-review-refund-integrity-db.spec.ts',
        test: 'approves the immutable refund snapshot and commits decision, refund, wallet credit, and audit atomically'
      }
    ],
    'AUTOMATED_PARTIAL_EXTERNAL_REMAINS'
  ),
  automatedA4(
    'BNUI-APR-002',
    ['AT-RBAC-005', 'AT-RBAC-006', 'AT-RBAC-011', 'AT-AUD-005'],
    [
      {
        file: 'tests/api-review-refund-integrity-db.spec.ts',
        test: 'cancels a superseded pending snapshot when a higher-level actor uses the compatible direct refund route'
      },
      {
        file: 'tests/api-review-refund-integrity-db.spec.ts',
        test: 'generically approves an immutable order resolution and links every resulting fact'
      }
    ]
  ),
  ...[
    'BNUI-FIN-001',
    'BNUI-FIN-002',
    'BNUI-FIN-003',
    'BNUI-REF-001',
    'BNUI-REF-002',
    'BNUI-REF-003',
    'BNUI-REF-004',
    'BNUI-REF-005',
    'BNUI-HIS-001'
  ].map((id) => planned('NUI-A5', id as `BNUI-${string}`)),
  ...[
    'BNUI-RPT-001',
    'BNUI-RPT-002',
    'BNUI-RPT-003',
    'BNUI-SET-001',
    'BNUI-SET-002',
    'BNUI-SET-003',
    'BNUI-SET-004',
    'BNUI-SET-005',
    'BNUI-SET-006'
  ].map((id) => planned('NUI-A6', id as `BNUI-${string}`)),
  ...[
    'BNUI-AUTH-001',
    'BNUI-RBAC-001',
    'BNUI-ROL-001',
    'BNUI-CFG-001',
    'BNUI-AUD-001',
    'BNUI-MET-001',
    'BNUI-LST-001',
    'BNUI-STATE-001',
    'BNUI-REC-001',
    'BNUI-REVW-001',
    'BNUI-REVW-002',
    'BNUI-BOT-001'
  ].map((id) => planned('NUI-A7', id as `BNUI-${string}`))
];
