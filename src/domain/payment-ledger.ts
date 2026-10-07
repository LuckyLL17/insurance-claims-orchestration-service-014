import { FxRateFact, FxConversionView, MonetaryAmount, PaymentEntry } from './types';
import { newId, iso } from './ids';

export interface PostPaymentInput {
  kind: PaymentEntry['kind'];
  /** 入账（支付账户/冲正目标/追回）币种金额的最小单位绝对值（>=0，符号由 kind 决定）。 */
  amountMinor: number;
  currency: string;
  /** 责任币种口径金额的最小单位绝对值（>=0，与换算依据同时提供）。 */
  liabilityMinor?: number;
  liabilityCurrency?: string;
  sourceId: string;
  authorizationRate?: FxRateFact;
  settlementRate?: FxRateFact;
  conversion?: FxConversionView;
  reverses?: { entryId: string; paymentEventId: string };
  linkedAuthorizationSourceId?: string;
  status?: PaymentEntry['status'];
}

export class PaymentLedger {
  private sign(kind: PaymentEntry['kind']): number { return kind === 'reversal' || kind === 'recovery' ? -1 : 1; }

  post(entries: PaymentEntry[], input: PostPaymentInput): PaymentEntry {
    if (this.find(entries, input.sourceId, input.kind)) throw new Error(`duplicate payment source ${input.sourceId}`);
    if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) throw new Error('payment amount must be a positive integer minor amount');
    const sign = this.sign(input.kind);
    const amount: MonetaryAmount = { currency: input.currency, minor: sign * input.amountMinor };
    let liability: MonetaryAmount | undefined;
    if (input.liabilityMinor !== undefined) {
      if (!Number.isInteger(input.liabilityMinor) || input.liabilityMinor <= 0) throw new Error('liability amount must be a positive integer minor amount');
      liability = { currency: input.liabilityCurrency ?? input.currency, minor: sign * input.liabilityMinor };
    }
    return {
      id: newId('payment'),
      kind: input.kind,
      amount,
      liability,
      sourceId: input.sourceId,
      status: input.status ?? 'posted',
      createdAt: iso(),
      authorizationRate: input.authorizationRate,
      settlementRate: input.settlementRate,
      conversion: input.conversion,
      reversesEntryId: input.reverses?.entryId,
      linkedAuthorizationSourceId: input.linkedAuthorizationSourceId,
      reverses: input.reverses,
    };
  }

  /** 重试保护：同一 (sourceId, kind) 已存在则直接取回原始流水，绝不再做一次换算。 */
  find(entries: PaymentEntry[], sourceId: string, kind: PaymentEntry['kind']): PaymentEntry | undefined {
    return entries.find((entry) => entry.sourceId === sourceId && entry.kind === kind);
  }

  /** 责任币种已用额度（授权 + 结算 - 冲正 - 追回），支付上限只在责任币种口径比较。 */
  liabilityBalance(entries: PaymentEntry[], currency: string): number {
    return entries.filter((e) => e.status === 'posted' && e.liability?.currency === currency).reduce((sum, e) => sum + (e.liability?.minor ?? 0), 0);
  }

  /** 某一币种账户口径余额（跨币种余额按币种分别累加）。 */
  currencyBalance(entries: PaymentEntry[], currency: string): number {
    return entries.filter((e) => e.status === 'posted' && e.amount.currency === currency).reduce((sum, e) => sum + e.amount.minor, 0);
  }

  /** 单币种历史口径（账户币种曾等于责任币种时使用）。 */
  balance(entries: PaymentEntry[]): number { return entries.filter((entry) => entry.status === 'posted').reduce((sum, entry) => sum + entry.amount.minor, 0); }
  settlementBalance(entries: PaymentEntry[]): number { return entries.filter((entry) => entry.kind === 'settlement' && entry.status === 'posted').reduce((sum, entry) => sum + entry.amount.minor, 0); }
}
