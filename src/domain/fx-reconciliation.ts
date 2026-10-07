import { AuthorizationRecord, ClaimState, FxDifferenceRecord, MonetaryAmount, PaymentEntry } from './types';
import { rateBasisHash } from './fx';

export interface AuthorizationReconciliation {
  sourceId: string;
  status: AuthorizationRecord['status'];
  authorized: { liability: MonetaryAmount; account: MonetaryAmount };
  settled: { liability: MonetaryAmount; account: MonetaryAmount };
  reversed: { liability: MonetaryAmount; account: MonetaryAmount };
  recovered: { liability: MonetaryAmount };
  /** 结算/冲正后未闭合的差额（责任币种与账户币种双口径，都应为 0 或被冲正解释）。 */
  open: { liability: MonetaryAmount; account: MonetaryAmount };
  rate: { sourceId: string; sourceVersion: string; rate: string; effectiveAt: string };
  /** 该授权下是否发生过冲正（发生后 open 表示待重新支付，不做闭合缺口检查）。 */
  hasReversal: boolean;
}

export interface FxReconciliationReport {
  claimId: string;
  liabilityCurrency: string;
  /** 跨币种余额：每个币种账户的应付/已付/冲正/追回净额。 */
  balancesByCurrency: Record<string, { paidMinor: number; reversalMinor: number; recoveryMinor: number; netMinor: number }>;
  /** 责任币种口径的授权、结算、冲正、追回与剩余应付。 */
  liability: {
    approvedMinor: number;
    authorizedMinor: number;
    settledMinor: number;
    reversedMinor: number;
    recoveredMinor: number;
    openPayableMinor: number;
  };
  authorizations: AuthorizationReconciliation[];
  /** 汇兑差额明细（成交汇率与授权依据不同、以及追回重估产生）。 */
  fxDifferences: FxDifferenceRecord[];
  fxDifferenceTotal: { currency: string; minor: number };
  /** 分期闭合校验：授权账户金额必须等于结算账户金额（末笔吸收残差），否则上报。 */
  roundingBreaches: string[];
  /** 冲正回滚校验：冲正必须精确引用并抵消原始流水（按原始汇率依据）。 */
  reversalBreaches: string[];
}

export class FxReconciler {
  report(claim: ClaimState): FxReconciliationReport {
    const lc = claim.liabilityCurrency;
    const currencies = new Set<string>([lc]);
    for (const entry of claim.payments) currencies.add(entry.amount.currency);

    const balancesByCurrency: FxReconciliationReport['balancesByCurrency'] = {};
    for (const currency of currencies) {
      const rows = claim.payments.filter((e) => (e.status === 'posted' || (e.kind === 'authorization' && e.status === 'pending')) && e.amount.currency === currency);
      const sum = (kind: PaymentEntry['kind']) => rows.filter((e) => e.kind === kind).reduce((s, e) => s + Math.abs(e.amount.minor), 0);
      const paid = sum('settlement');
      const reversal = sum('reversal');
      const recovery = sum('recovery');
      balancesByCurrency[currency] = { paidMinor: paid, reversalMinor: reversal, recoveryMinor: recovery, netMinor: paid - reversal - recovery };
    }

    const liabilityRows = claim.payments.filter((e) => (e.status === 'posted' || (e.kind === 'authorization' && e.status === 'pending')) && e.liability?.currency === lc);
    const lsum = (kind: PaymentEntry['kind']) => liabilityRows.filter((e) => e.kind === kind).reduce((s, e) => s + Math.abs(e.liability?.minor ?? 0), 0);
    const authorizedMinor = lsum('authorization');
    const settledMinor = lsum('settlement');
    const reversedMinor = lsum('reversal');
    const recoveredMinor = lsum('recovery');

    const authorizations = [...claim.authorizations.values()].map((auth) => this.authorization(claim, auth));

    return {
      claimId: claim.id,
      liabilityCurrency: lc,
      balancesByCurrency,
      liability: {
        approvedMinor: claim.approvedMinor,
        authorizedMinor,
        settledMinor,
        reversedMinor,
        recoveredMinor,
        openPayableMinor: claim.approvedMinor - settledMinor + reversedMinor,
      },
      authorizations,
      fxDifferences: claim.fxDifferences,
      fxDifferenceTotal: { currency: lc, minor: claim.fxDifferences.reduce((s, d) => s + d.minor, 0) },
      roundingBreaches: this.roundingBreaches(claim, authorizations),
      reversalBreaches: this.reversalBreaches(claim),
    };
  }

  /** 跨币种余额接口：按币种返回账户净额，并标注冲正/追回。 */
  balances(claim: ClaimState): Record<string, { netMinor: number; currency: string }> {
    const report = this.report(claim);
    return Object.fromEntries(Object.entries(report.balancesByCurrency).map(([currency, row]) => [currency, { currency, netMinor: row.netMinor }]));
  }

  /** 汇兑差额接口：只汇总依据不同产生的差额，并给出每笔依据。 */
  fxDifferences(claim: ClaimState): { lines: FxDifferenceRecord[]; total: { currency: string; minor: number } } {
    return { lines: claim.fxDifferences, total: { currency: claim.liabilityCurrency, minor: claim.fxDifferences.reduce((s, d) => s + d.minor, 0) } };
  }

  private authorization(claim: ClaimState, auth: AuthorizationRecord): AuthorizationReconciliation {
    // 授权流水自身以 sourceId 标识；结算/冲正/追回通过 linkedAuthorizationSourceId 归属。
    // 全额冲正授权时授权流水会变 voided，仍需计入，因此这里不按 status 过滤。
    const belongs = (e: PaymentEntry) => e.kind === 'authorization' ? e.sourceId === auth.sourceId : e.linkedAuthorizationSourceId === auth.sourceId;
    const rows = claim.payments.filter(belongs);
    const accountCurrency = auth.accountCurrency;
    const acc = (kind: PaymentEntry['kind']) => rows.filter((e) => e.kind === kind).reduce((s, e) => s + Math.abs(e.amount.minor), 0);
    const lia = (kind: PaymentEntry['kind']) => rows.filter((e) => e.kind === kind).reduce((s, e) => s + Math.abs(e.liability?.minor ?? 0), 0);
    const settledAccount = acc('settlement');
    const reversedAccount = acc('reversal');
    const hasReversal = rows.some((e) => e.kind === 'reversal' && e.status === 'posted');
    return {
      sourceId: auth.sourceId,
      status: auth.status,
      authorized: { liability: { currency: lc(claim), minor: Math.abs(auth.authorizedLiability.minor) }, account: { currency: accountCurrency, minor: Math.abs(auth.authorizedAccount.minor) } },
      settled: { liability: { currency: lc(claim), minor: lia('settlement') }, account: { currency: accountCurrency, minor: settledAccount } },
      reversed: { liability: { currency: lc(claim), minor: lia('reversal') }, account: { currency: accountCurrency, minor: reversedAccount } },
      recovered: { liability: { currency: lc(claim), minor: lia('recovery') } },
      open: {
        liability: { currency: lc(claim), minor: Math.abs(auth.authorizedLiability.minor) - lia('settlement') + lia('reversal') },
        account: { currency: accountCurrency, minor: Math.abs(auth.authorizedAccount.minor) - settledAccount + reversedAccount },
      },
      rate: { sourceId: auth.rate.sourceId, sourceVersion: auth.rate.sourceVersion, rate: auth.rate.rate, effectiveAt: auth.rate.effectiveAt },
      hasReversal,
    };
  }

  private roundingBreaches(_claim: ClaimState, authorizations: AuthorizationReconciliation[]): string[] {
    const breaches: string[] = [];
    for (const auth of authorizations) {
      // 闭合检查只针对正常分期、未发生冲正且已全额结算的授权；
      // reversed（已关闭）或冲正后回到 open（待重新支付）的授权不参与。
      if (auth.status !== 'fully_settled' || auth.hasReversal) continue;
      if (auth.open.account.minor !== 0) breaches.push(`authorization ${auth.sourceId}: account rounding gap ${auth.open.account.minor} ${auth.open.account.currency}`);
      if (auth.open.liability.minor !== 0) breaches.push(`authorization ${auth.sourceId}: liability gap ${auth.open.liability.minor} ${auth.open.liability.currency}`);
    }
    return breaches;
  }

  private reversalBreaches(claim: ClaimState): string[] {
    const breaches: string[] = [];
    for (const entry of claim.payments.filter((e) => e.kind === 'reversal' && e.status === 'posted')) {
      const original = entry.reverses ? claim.payments.find((e) => e.id === entry.reverses!.entryId) : undefined;
      if (!original) { breaches.push(`reversal ${entry.sourceId} does not reference an original entry`); continue; }
      // 精确回滚：冲正账户金额必须与原流水同币种、同金额、依据哈希相同（全额冲正为负镜像）。
      if (entry.amount.currency !== original.amount.currency) breaches.push(`reversal ${entry.sourceId} currency ${entry.amount.currency} != original ${original.amount.currency}`);
      if (entry.authorizationRate && original.authorizationRate && rateBasisHash(entry.authorizationRate) !== rateBasisHash(original.authorizationRate)) breaches.push(`reversal ${entry.sourceId} revalued against a different fx basis`);
      if (Math.abs(entry.amount.minor) > Math.abs(original.amount.minor)) breaches.push(`reversal ${entry.sourceId} exceeds original amount`);
    }
    return breaches;
  }
}

function lc(claim: ClaimState): string { return claim.liabilityCurrency; }
