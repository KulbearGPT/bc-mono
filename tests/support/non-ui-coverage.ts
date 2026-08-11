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
  ...[
    'BNUI-CAT-001',
    'BNUI-CAT-002',
    'BNUI-PKG-001',
    'BNUI-PKG-002',
    'BNUI-TAG-001',
    'BNUI-PLY-001',
    'BNUI-PLY-002',
    'BNUI-PLY-003'
  ].map((id) => planned('NUI-A2', id as `BNUI-${string}`)),
  ...[
    'BNUI-ORD-001',
    'BNUI-ORD-002',
    'BNUI-ORD-003',
    'BNUI-ORD-004',
    'BNUI-ORD-005',
    'BNUI-ORD-006',
    'BNUI-ORD-007',
    'BNUI-ORD-008',
    'BNUI-SEL-001',
    'BNUI-SEL-002',
    'BNUI-SEL-003',
    'BNUI-SEL-004',
    'BNUI-SEL-005',
    'BNUI-RDY-001',
    'BNUI-RDY-002',
    'BNUI-RDY-003',
    'BNUI-SVC-001',
    'BNUI-SVC-002'
  ].map((id) => planned('NUI-A3', id as `BNUI-${string}`)),
  ...[
    'BNUI-CXL-001',
    'BNUI-CXL-002',
    'BNUI-CXL-003',
    'BNUI-ORD-009',
    'BNUI-SUP-001',
    'BNUI-SUP-002',
    'BNUI-SUP-003',
    'BNUI-SUP-004',
    'BNUI-SUP-005',
    'BNUI-SUP-006',
    'BNUI-APR-001',
    'BNUI-APR-002'
  ].map((id) => planned('NUI-A4', id as `BNUI-${string}`)),
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
