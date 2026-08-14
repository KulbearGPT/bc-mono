Acceptance ID: AT-REC-005
candidateRef: git:65e9fe61886fd861a3202b5f07d57b86ec47ea23
executedAt: 2026-07-19T23:38:53.000Z
executor: Codex local recovery verifier
environment: isolated temporary PostgreSQL
Redaction: No production data, production credentials, temporary socket paths, connection secrets, or personal data are included; no controlled unredacted artifact was required for this synthetic probe.

## Preconditions
An isolated temporary PostgreSQL source cluster contained one synthetic user and one synthetic audit record. This artifact is deliberately narrower than the authoritative `AT-REC-005` contract, is not listed in the external acceptance ledger, and must not be treated as an `AT-REC-005` pass.

## Steps
1. Run `bash scripts/verify-backup-restore.sh`.
2. Produce a custom-format backup of the temporary source cluster.
3. Restore it into a fresh isolated cluster.
4. Compare the synthetic row counts and probe the restored audit deletion guard.

## Expected Result
The narrow local probe should restore one user and one audit row, preserve the audit deletion prohibition, and emit `backup-restore-ok`. It does not test the full `AT-REC-005` acceptance scope.

## Actual Result
The command exited with code `0` and emitted:

```text
restored_users=1
restored_audits=1
audit-delete-rejected
backup-restore-ok
```

The observed output matched all four narrow probe assertions.

## Diagnostics
The probe did not include representative orders, transactions, gifts, commissions, earnings, or tasks. It did not start the API or Bot, validate the restored business graph's referential integrity, verify the full immutable stream, or demonstrate that an active order can continue after recovery. It therefore does not satisfy `AT-REC-005`, which remains `PENDING_EXTERNAL`.
