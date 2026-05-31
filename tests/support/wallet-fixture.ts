import type { WalletBalance, WalletFundingService } from '@blackcat/api/wallet';

export class TestWalletFunding implements WalletFundingService {
  ledgerBalanceMinor: number;
  version = 1;
  private sequence = 0;
  private readonly reservations = new Map<string, { amountMinor: number; active: boolean; version: number }>();

  constructor(balanceMinor = 1_000_000) {
    this.ledgerBalanceMinor = balanceMinor;
  }

  async getBalance(input: { userId: string; now: Date }): Promise<WalletBalance> {
    return this.balance(input.now);
  }

  async reserve(input: { userId: string; sourceType: 'ORDER' | 'GIFT'; sourceId: string; amountMinor: number;
    idempotencyKey: string; expiresAt: Date; now: Date }) {
    if (this.balance(input.now).availableMinor < input.amountMinor) throw new Error('INSUFFICIENT_AVAILABLE_BALANCE');
    const reservationId = `test-wallet-reservation-${++this.sequence}`;
    this.reservations.set(reservationId, { amountMinor: input.amountMinor, active: true, version: 1 });
    this.version += 1;
    return { reservationId, balance: this.balance(input.now) };
  }

  async capture(input: { reservationId: string; expectedVersion: number; idempotencyKey: string; now: Date }) {
    const reservation = this.activeReservation(input.reservationId, input.expectedVersion);
    reservation.active = false;
    reservation.version += 1;
    this.ledgerBalanceMinor -= reservation.amountMinor;
    this.version += 1;
    return { walletEntryId: `test-wallet-entry-${++this.sequence}`, balance: this.balance(input.now) };
  }

  async release(input: { reservationId: string; expectedVersion: number; idempotencyKey: string; now: Date }) {
    const reservation = this.activeReservation(input.reservationId, input.expectedVersion);
    reservation.active = false;
    reservation.version += 1;
    this.version += 1;
    return { reservationId: input.reservationId, balance: this.balance(input.now) };
  }

  async creditBusinessRefund(input: { userId: string; orderId: string; refundId: string; amountMinor: number;
    idempotencyKey: string; now: Date }) {
    this.ledgerBalanceMinor += input.amountMinor;
    this.version += 1;
    return { walletEntryId: `test-wallet-entry-${++this.sequence}`, balance: this.balance(input.now) };
  }

  addReservation(reservationId: string, amountMinor: number, version = 1): void {
    this.reservations.set(reservationId, { amountMinor, active: true, version });
  }

  private activeReservation(id: string, expectedVersion: number) {
    const reservation = this.reservations.get(id);
    if (!reservation || !reservation.active || reservation.version !== expectedVersion) throw new Error('CONFLICT');
    return reservation;
  }

  private balance(now: Date): WalletBalance {
    const reservedMinor = [...this.reservations.values()].filter((item) => item.active)
      .reduce((total, item) => total + item.amountMinor, 0);
    return { ledgerBalanceMinor: this.ledgerBalanceMinor, reservedMinor,
      availableMinor: this.ledgerBalanceMinor - reservedMinor, currency: 'CAT', calculatedAt: now.toISOString(), version: this.version };
  }
}
