import { describe, expect, test } from "vitest";
import {
  buildWalletAdjustmentRequest,
  walletAdjustmentCandidates,
} from "../apps/dashboard/src/customer-wallet.js";

const entries = [
  {
    id: "00000000-0000-0000-0000-000000000701",
    entryType: "TOP_UP_CREDIT",
    direction: "CREDIT" as const,
    amountMinor: 5000,
    currency: "CAT" as const,
    sourceType: "TOP_UP",
    sourceId: "receipt-701",
    occurredAt: "2026-08-05T09:00:00.000Z",
  },
  {
    id: "00000000-0000-0000-0000-000000000702",
    entryType: "ADJUSTMENT_DEBIT",
    direction: "DEBIT" as const,
    amountMinor: 500,
    currency: "CAT" as const,
    sourceType: "WALLET_ADJUSTMENT",
    sourceId: "adjustment-702",
    reversalOfEntryId: "00000000-0000-0000-0000-000000000701",
    occurredAt: "2026-08-05T10:00:00.000Z",
  },
];

describe("M15-US-05 wallet Adjustment Dashboard model", () => {
  test("only offers original business entries as reversal evidence", () => {
    expect(walletAdjustmentCandidates(entries).map((entry) => entry.id)).toEqual([
      "00000000-0000-0000-0000-000000000701",
    ]);
  });

  test("builds a canonical minor-unit append-only request", () => {
    expect(
      buildWalletAdjustmentRequest(
        "00000000-0000-0000-0000-000000000501",
        {
          direction: "DEBIT",
          amountMinor: 125,
          reversalOfEntryId: "00000000-0000-0000-0000-000000000701",
          reason: "充值收据复核后确认多记 12.5 CAT。",
        },
        4,
      ),
    ).toEqual({
      method: "POST",
      path: "/api/v1/admin/users/00000000-0000-0000-0000-000000000501/wallet-adjustments",
      body: {
        entryType: "ADJUSTMENT_DEBIT",
        amountMinor: 125,
        reversalOfEntryId: "00000000-0000-0000-0000-000000000701",
        reason: "充值收据复核后确认多记 12.5 CAT。",
        expectedWalletVersion: 4,
      },
    });
  });
});
