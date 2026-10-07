import { ClaimService } from './claim-service';
import { PaymentLedger } from '../domain/payment-ledger';
import { FxConversion, FxRateBook, convertWithSnapshot } from '../domain/fx';
import { MonetaryAmount, PaymentEntry } from '../domain/types';
import { asMinor, iso } from '../domain/ids';

export interface PaymentInput { amount: number; currency: string; sourceId: string; }
export interface ReversalInput { sourceId: string; settlementSourceId?: string; amount?: number; currency?: string; }
export interface RecoveryInput extends PaymentInput { againstSourceId?: string; }

export class PaymentService {
  constructor(private readonly claims: ClaimService, private readonly ledger: PaymentLedger, private readonly fx: FxRateBook) {}

  private liabilityCurrency(claimId: string): string {
    const claim = this.claims.get(claimId);
    return claim.liabilityCurrency || claim.policy?.currency || claim.loss.currency;
  }

  private convert(amount: PaymentInput, targetCurrency: string): FxConversion {
    return this.fx.convert({ currency: amount.currency, minor: asMinor(amount.amount) }, targetCurrency, iso());
  }

  /** 支付授权：冻结授权时刻的汇率快照，占用责任币种额度但不计入已结算。 */
  authorize(claimId: string, input: PaymentInput, actor: string) {
    const claim = this.claims.get(claimId);
    if (claim.status === 'rejected') throw new Error('rejected claim cannot be paid');
    if (claim.payments.some((p) => p.kind === 'authorization' && p.sourceId === input.sourceId)) return claim; // 重试不重复换算
    const liabilityCurrency = this.liabilityCurrency(claimId);
    const conversion = this.convert(input, liabilityCurrency);
    const reserved = this.ledger.kindBalance(claim.payments, 'authorization') + this.ledger.settlementBalance(claim.payments);
    if (reserved + conversion.to.minor > claim.approvedMinor) throw new Error('authorization exceeds approved amount');
    const payment = this.ledger.post(claim.payments, { ...input, kind: 'authorization', conversion });
    return this.claims.addEvent(claimId, 'payment.authorized', { payment }, actor, `payment:${input.sourceId}`);
  }

  /** 结算：同一 sourceId 重试直接返回既有状态，不会重新换算。 */
  settle(claimId: string, input: PaymentInput, actor: string) {
    const claim = this.claims.get(claimId);
    if (claim.status === 'rejected') throw new Error('rejected claim cannot be paid');
    if (claim.payments.some((p) => p.kind === 'settlement' && p.sourceId === input.sourceId)) return claim; // 幂等重试
    const liabilityCurrency = this.liabilityCurrency(claimId);
    const conversion = this.convert(input, liabilityCurrency);
    if (this.ledger.settlementBalance(claim.payments) + conversion.to.minor > claim.approvedMinor) throw new Error('payment exceeds approved amount');
    const payment = this.ledger.post(claim.payments, { ...input, kind: 'settlement', conversion });
    return this.claims.addEvent(claimId, 'payment.settled', { payment }, actor, `payment:${input.sourceId}`);
  }

  /**
   * 冲正：指定 settlementSourceId 时精确回滚到原始结算冻结的汇率依据。
   * 全额冲正直接取原始条目的责任币种折算值取负；部分冲正用原始冻结快照换算，
   * 绝不使用当前汇率。
   */
  reverse(claimId: string, input: ReversalInput, actor: string) {
    const claim = this.claims.get(claimId);
    if (claim.payments.some((p) => p.kind === 'reversal' && p.sourceId === input.sourceId)) return claim; // 幂等重试
    const liabilityCurrency = this.liabilityCurrency(claimId);
    let amount: number;
    let currency: string;
    let conversion: FxConversion | undefined;
    let reversalOf: string | undefined;

    if (input.settlementSourceId) {
      const original = claim.payments.find((p) => p.kind === 'settlement' && p.sourceId === input.settlementSourceId && p.status === 'posted');
      if (!original) throw new Error(`unknown settlement ${input.settlementSourceId}`);
      reversalOf = original.sourceId;
      currency = original.amount.currency;
      if (input.amount === undefined) {
        // 全额冲正：完全沿用原始条目的金额与折算事实
        amount = original.amount.minor / 100;
        conversion = { from: original.amount, to: original.liability ?? original.amount, fx: original.fx ?? null, residualMicro: original.residualMicro ?? 0 };
      } else {
        // 部分冲正：用原始结算冻结的汇率快照换算，不回当前汇率源询价
        amount = input.amount;
        const requested: MonetaryAmount = { currency, minor: asMinor(input.amount) };
        const reversed = claim.payments.filter((p) => p.kind === 'reversal' && p.reversalOf === original.sourceId).reduce((sum, p) => sum + Math.abs(p.amount.minor), 0);
        if (reversed + requested.minor > original.amount.minor) throw new Error(`reversal exceeds original settlement ${original.sourceId}`);
        conversion = original.fx ? convertWithSnapshot(requested, liabilityCurrency, original.fx) : this.fx.convert(requested, liabilityCurrency, iso());
      }
    } else {
      if (input.amount === undefined || !input.currency) throw new Error('amount and currency are required without settlementSourceId');
      amount = input.amount;
      currency = input.currency;
      conversion = this.convert({ amount, currency, sourceId: input.sourceId }, liabilityCurrency);
    }

    const payment = this.ledger.post(claim.payments, { kind: 'reversal', amount, currency, sourceId: input.sourceId, conversion, reversalOf });
    return this.claims.addEvent(claimId, 'payment.reversed', { payment }, actor, `reversal:${input.sourceId}`);
  }

  /**
   * 追回：按当前有效汇率折算入账；若针对某笔跨币种结算且追回币种与结算币种相同，
   * 以原始冻结汇率与当前汇率的折算差确认汇兑差额（责任币种）。
   */
  recover(claimId: string, input: RecoveryInput, actor: string) {
    const claim = this.claims.get(claimId);
    if (claim.payments.some((p) => p.kind === 'recovery' && p.sourceId === input.sourceId)) return claim; // 幂等重试
    const liabilityCurrency = this.liabilityCurrency(claimId);
    const conversion = this.convert(input, liabilityCurrency);
    let exchangeDifference: MonetaryAmount | undefined;
    if (input.againstSourceId) {
      const original = claim.payments.find((p) => p.kind === 'settlement' && p.sourceId === input.againstSourceId && p.status === 'posted');
      if (!original) throw new Error(`unknown settlement ${input.againstSourceId}`);
      if (original.fx && original.amount.currency === input.currency) {
        const atOriginalRate = convertWithSnapshot({ currency: input.currency, minor: asMinor(input.amount) }, liabilityCurrency, original.fx);
        const diffMinor = atOriginalRate.to.minor - conversion.to.minor;
        if (diffMinor !== 0) exchangeDifference = { currency: liabilityCurrency, minor: diffMinor };
      }
    }
    const payment = this.ledger.post(claim.payments, { ...input, kind: 'recovery', conversion, reversalOf: input.againstSourceId, exchangeDifference });
    return this.claims.addEvent(claimId, 'payment.recovered', { payment }, actor, `recovery:${input.sourceId}`);
  }

  /** 跨币种余额视图。 */
  balances(claimId: string) {
    const claim = this.claims.get(claimId);
    const liabilityCurrency = this.liabilityCurrency(claimId);
    const settledNet = this.ledger.settlementBalance(claim.payments);
    return {
      claimId,
      liabilityCurrency,
      approvedMinor: claim.approvedMinor,
      remainingMinor: claim.approvedMinor - settledNet,
      byCurrency: this.ledger.balanceByCurrency(claim.payments),
      liability: {
        authorized: this.ledger.kindBalance(claim.payments, 'authorization'),
        settledNet,
        recovered: -this.ledger.kindBalance(claim.payments, 'recovery'),
        net: this.ledger.liabilityBalance(claim.payments),
      },
      residualMicroTotal: this.ledger.residualMicroTotal(claim.payments),
    };
  }

  /** 汇兑差额视图：舍入残差总额 + 追回产生的汇兑差额明细。 */
  fxDifferences(claimId: string) {
    const claim = this.claims.get(claimId);
    const liabilityCurrency = this.liabilityCurrency(claimId);
    const exchangeDifferences = claim.payments
      .filter((p) => p.status === 'posted' && p.exchangeDifference)
      .map((p) => ({ sourceId: p.sourceId, kind: p.kind, againstSourceId: p.reversalOf, ...p.exchangeDifference! }));
    return {
      claimId,
      liabilityCurrency,
      residualMicroTotal: this.ledger.residualMicroTotal(claim.payments),
      exchangeDifferences,
      totalExchangeDifferenceMinor: exchangeDifferences.reduce((sum, d) => sum + d.minor, 0),
    };
  }

  /** 支付对账：逐笔列示冻结汇率事实与责任币种折算，供与支付渠道对账。 */
  reconciliation(claimId: string) {
    const claim = this.claims.get(claimId);
    const liabilityCurrency = this.liabilityCurrency(claimId);
    const entries = claim.payments.filter((p) => p.status === 'posted').map((p) => ({
      id: p.id,
      kind: p.kind,
      sourceId: p.sourceId,
      reversalOf: p.reversalOf,
      amount: p.amount,
      liability: p.liability ?? p.amount,
      fx: p.fx ?? null,
      residualMicro: p.residualMicro ?? 0,
      exchangeDifference: p.exchangeDifference ?? null,
      createdAt: p.createdAt,
    }));
    return {
      claimId,
      liabilityCurrency,
      approvedMinor: claim.approvedMinor,
      entries,
      totals: {
        byCurrency: this.ledger.balanceByCurrency(claim.payments),
        liabilityNetMinor: this.ledger.liabilityBalance(claim.payments),
        settlementNetMinor: this.ledger.settlementBalance(claim.payments),
        residualMicroTotal: this.ledger.residualMicroTotal(claim.payments),
        exchangeDifferenceMinor: entries.reduce((sum, e) => sum + (e.exchangeDifference?.minor ?? 0), 0),
      },
    };
  }
}
