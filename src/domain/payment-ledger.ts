import { MonetaryAmount, PaymentEntry } from './types';
import { FxConversion } from './fx';
import { asMinor, newId, iso } from './ids';

const NEGATIVE_KINDS = new Set<PaymentEntry['kind']>(['reversal', 'recovery']);

export class PaymentLedger {
  post(entries: PaymentEntry[], input: { kind: PaymentEntry['kind']; amount: number; currency: string; sourceId: string; conversion?: FxConversion; reversalOf?: string; exchangeDifference?: MonetaryAmount }): PaymentEntry {
    if (entries.some((entry) => entry.sourceId === input.sourceId && entry.kind === input.kind)) throw new Error(`duplicate payment source ${input.sourceId}`);
    const amount = asMinor(input.amount);
    if (amount === 0) throw new Error('payment amount must be positive');
    const sign = NEGATIVE_KINDS.has(input.kind) ? -1 : 1;
    const conversion = input.conversion;
    if (conversion?.fx) {
      const [base, quote] = conversion.fx.pair.split('/');
      if (![base, quote].includes(input.currency)) throw new Error(`fx snapshot ${conversion.fx.pair} does not cover ${input.currency}`);
    }
    return {
      id: newId('payment'),
      kind: input.kind,
      amount: { currency: input.currency, minor: sign * amount },
      sourceId: input.sourceId,
      status: 'posted',
      createdAt: iso(),
      fx: conversion?.fx ?? null,
      liability: conversion ? { currency: conversion.to.currency, minor: sign * conversion.to.minor } : { currency: input.currency, minor: sign * amount },
      residualMicro: conversion ? sign * conversion.residualMicro : 0,
      reversalOf: input.reversalOf,
      exchangeDifference: input.exchangeDifference,
    };
  }

  /** 条目在责任币种下的折算金额；无换算事实的条目视同责任币种。 */
  private liabilityMinor(entry: PaymentEntry): number { return entry.liability?.minor ?? entry.amount.minor; }
  private posted(entries: PaymentEntry[]): PaymentEntry[] { return entries.filter((entry) => entry.status === 'posted'); }

  /** 跨币种余额：按支付账户币种分别汇总（带符号）。 */
  balanceByCurrency(entries: PaymentEntry[]): Record<string, number> {
    const balances: Record<string, number> = {};
    for (const entry of this.posted(entries)) balances[entry.amount.currency] = (balances[entry.amount.currency] ?? 0) + entry.amount.minor;
    return balances;
  }

  /** 责任币种净额：全部条目按各自冻结汇率折算后求和。 */
  liabilityBalance(entries: PaymentEntry[]): number { return this.posted(entries).reduce((sum, entry) => sum + this.liabilityMinor(entry), 0); }
  /** 责任币种口径的净结算额（结算 + 冲正），用于赔付上限校验。 */
  settlementBalance(entries: PaymentEntry[]): number { return this.posted(entries).filter((entry) => entry.kind === 'settlement' || entry.kind === 'reversal').reduce((sum, entry) => sum + this.liabilityMinor(entry), 0); }
  kindBalance(entries: PaymentEntry[], kind: PaymentEntry['kind']): number { return this.posted(entries).filter((entry) => entry.kind === kind).reduce((sum, entry) => sum + this.liabilityMinor(entry), 0); }
  residualMicroTotal(entries: PaymentEntry[]): number { return this.posted(entries).reduce((sum, entry) => sum + (entry.residualMicro ?? 0), 0); }
}
