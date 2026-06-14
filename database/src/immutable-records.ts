export const IMMUTABLE_RECORD_TABLES = [
  'orders',
  'order_events',
  'order_participant_events',
  'order_resolutions',
  'external_transactions',
  'refunds',
  'fund_reservations',
  'fund_reservation_events',
  'gift_requests',
  'consumption_entries',
  'commissions',
  'commission_adjustments',
  'player_earnings',
  'player_earning_adjustments',
  'wallet_entries',
  'top_ups',
  'external_refund_debits',
  'receipt_attachments',
  'audit_logs',
  'audit_log_changes',
  'guild_bot_config_events'
] as const;

export type ImmutableRecordTable = (typeof IMMUTABLE_RECORD_TABLES)[number];
export type RecordMutation = 'delete' | 'updateAmount' | 'updateStatus' | 'appendAdjustment';

const immutableRecordTableSet = new Set<string>(IMMUTABLE_RECORD_TABLES);
const statusImmutableTableSet = new Set<string>([
  'audit_logs',
  'order_events',
  'order_participant_events',
  'fund_reservation_events',
  'commission_adjustments',
  'player_earning_adjustments',
  'wallet_entries',
  'top_ups',
  'external_refund_debits',
  'receipt_attachments',
  'audit_log_changes',
  'guild_bot_config_events'
]);

export function isImmutableRecordTable(tableName: string): tableName is ImmutableRecordTable {
  return immutableRecordTableSet.has(tableName);
}

export function assertAllowedRecordMutation(tableName: string, mutation: RecordMutation): void {
  if (mutation === 'delete' && isImmutableRecordTable(tableName)) {
    throw new Error(`Hard delete is forbidden for immutable record table ${tableName}.`);
  }

  if (mutation === 'updateAmount' && isImmutableRecordTable(tableName)) {
    throw new Error(`Protected amount overwrite is forbidden for immutable record table ${tableName}.`);
  }

  if (mutation === 'updateStatus' && statusImmutableTableSet.has(tableName)) {
    throw new Error(`Immutable status overwrite is forbidden for immutable record table ${tableName}.`);
  }
}
