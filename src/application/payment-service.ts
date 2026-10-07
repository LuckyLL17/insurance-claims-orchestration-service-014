import { ClaimService } from './claim-service';
import { EventStore } from './event-store';
import { PaymentLedger } from '../domain/payment-ledger';
import { AuthorizationRecord, ClaimState, FxConversionView, FxDifferenceRecord, FxRateFact, MonetaryAmount, PaymentEntry } from '../domain/types';
import {
  conversionView, convertBackMinor, convertMinor, CurrencyRegistry, ExplicitRate, FxRateBoard,
  negateResidual, rateBasisHash, residualForFinalSlice,
} from '../domain/fx';
import { iso, newId } from '../domain/ids';

export interface AuthorizeInput {
  sourceId: string;
  /** 授权金额，主币单位；按 amountCurrency 解释（默认责任币种）。 */
  amount: number;
  amountCurrency?: string;
  accountCurrency: string;
  at?: string;
  sourceVersion?: string;
  fxSourceId?: string;
}

export interface SettleInput {
  sourceId: string;
  /** 支付账户币种（与授权账户币种一致）。 */
  accountCurrency?: string;
  /** 以责任币种申报的分期金额（主币单位）；不提供则结清整张授权。 */
  liabilityAmount?: number;
  /** 以支付账户币种申报的到账金额（主币单位，按成交汇率换算回责任口径）。 */
  accountAmount?: number;
  authorizationSourceId?: string;
  /** 无预授权时自动授权（兼容旧接口）。 */
  amount?: number;
  currency?: string;
  at?: string;
  /** 支付渠道实际成交汇率；不提供则使用授权冻结依据。 */
  explicitRate?: ExplicitRate;
  sourceVersion?: string;
}

export interface ReverseInput {
  sourceId: string;
  /** 被冲正的流水 sourceId（结算或授权）。 */
  reversesSourceId: string;
  /** 部分冲正：以原始账户币种主币单位给出金额；不提供则全额镜像回滚。 */
  amount?: number;
  at?: string;
}

export interface RecoverInput {
  sourceId: string;
  /** 追回入账币种（可以不同于损失/责任/支付币种）。 */
  currency: string;
  amount: number;
  /** 追回关联的授权 sourceId，用于计算汇兑差额。 */
  authorizationSourceId?: string;
  at?: string;
  sourceVersion?: string;
}

export class PaymentService {
  constructor(
    private readonly claims: ClaimService,
    private readonly ledger: PaymentLedger,
    private readonly fx: FxRateBoard,
    private readonly currencies: CurrencyRegistry,
    private readonly events: EventStore,
  ) {}

  authorize(claimId: string, input: AuthorizeInput, actor: string): ClaimState {
    const claim = this.claims.get(claimId);
    if (claim.status === 'rejected') throw new Error('rejected claim cannot be authorized');
    const retry = this.ledger.find(claim.payments, input.sourceId, 'authorization');
    if (retry) return this.claims.get(claimId); // 同一支付重试：直接返回，绝不重新换算

    const lc = claim.liabilityCurrency;
    const amountCurrency = (input.amountCurrency ?? lc).toUpperCase();
    const accountCurrency = input.accountCurrency.toUpperCase();
    const at = iso(input.at ?? claim.lossAt);

    let liabilityMinor: number;
    let requestRate: FxRateFact | undefined;
    let requestView: FxConversionView | undefined;
    if (amountCurrency === lc) {
      liabilityMinor = this.currencies.toMinor(input.amount, lc);
    } else {
      requestRate = this.fx.freeze(amountCurrency, lc, at, { sourceId: input.fxSourceId, sourceVersion: input.sourceVersion });
      const requestedMinor = this.currencies.toMinor(input.amount, amountCurrency);
      const converted = convertMinor(requestRate, requestedMinor, this.currencies);
      liabilityMinor = converted.toMinor;
      requestView = conversionView(requestRate, { currency: amountCurrency, minor: requestedMinor }, liabilityMinor, converted.residual, { stage: 'authorization_request' });
    }

    this.assertWithinApproval(claim, lc, liabilityMinor);

    // 授权汇率：责任币种 -> 支付账户币种，冻结在授权时点（以损失时点为有效时间基准取报价）。
    const rate = this.fx.freeze(lc, accountCurrency, at, { sourceId: input.fxSourceId, sourceVersion: input.sourceVersion });
    const converted = convertMinor(rate, liabilityMinor, this.currencies);
    const liabilityAmount: MonetaryAmount = { currency: lc, minor: liabilityMinor };
    const view = conversionView(rate, liabilityAmount, converted.toMinor, converted.residual, { stage: 'authorization' });

    const payment = this.ledger.post(claim.payments, {
      kind: 'authorization',
      amountMinor: converted.toMinor,
      currency: accountCurrency,
      liabilityMinor,
      liabilityCurrency: lc,
      sourceId: input.sourceId,
      authorizationRate: rate,
      conversion: view,
      status: 'pending',
    });
    const eventId = newId('event');
    const authorization: AuthorizationRecord = {
      sourceId: input.sourceId,
      paymentId: payment.id,
      eventId,
      authorizedLiability: { currency: lc, minor: liabilityMinor },
      accountCurrency,
      authorizedAccount: { currency: accountCurrency, minor: converted.toMinor },
      rate,
      status: 'open',
      createdAt: payment.createdAt,
      settledLiabilityMinor: 0,
      settledAccountMinor: 0,
      carriedRoundingMinor: 0,
    };
    this.events.append(claimId, 'payment.authorized', { payment, requestedIn: requestView, authorization }, actor, `auth:${input.sourceId}`, undefined, eventId);
    return this.claims.get(claimId);
  }

  settle(claimId: string, input: SettleInput, actor: string): ClaimState {
    const claim = this.claims.get(claimId);
    if (claim.status === 'rejected') throw new Error('rejected claim cannot be paid');
    const retry = this.ledger.find(claim.payments, input.sourceId, 'settlement');
    if (retry) return this.claims.get(claimId); // 支付重试：流水已存在，直接返回，不会重复换算

    let authSourceId = input.authorizationSourceId;
    let working = claim;
    // 兼容旧接口：没有预授权时，按支付币种即责任币种自动授权（恒等汇率）。
    if (!authSourceId && input.amount !== undefined) {
      const currency = (input.currency ?? claim.liabilityCurrency).toUpperCase();
      if (currency !== claim.liabilityCurrency) throw new Error('cross-currency payment requires an explicit authorization');
      authSourceId = `auto:${input.sourceId}`;
      working = this.authorize(claimId, { sourceId: authSourceId, amount: input.amount, amountCurrency: currency, accountCurrency: currency, at: input.at }, 'system');
    }
    if (!authSourceId) throw new Error('settlement requires authorizationSourceId or an amount');
    const auth = working.authorizations.get(authSourceId);
    if (!auth) throw new Error(`unknown authorization ${authSourceId}`);
    if (auth.status === 'reversed') throw new Error(`authorization ${authSourceId} is reversed`);

    const lc = claim.liabilityCurrency;
    const accountCurrency = (input.accountCurrency ?? auth.accountCurrency).toUpperCase();
    if (accountCurrency !== auth.accountCurrency) throw new Error(`settlement currency ${accountCurrency} differs from authorized account currency ${auth.accountCurrency}`);
    const remainingLiability = Math.abs(auth.authorizedLiability.minor) - auth.settledLiabilityMinor;

    let liabilityMinor: number;
    if (input.liabilityAmount !== undefined) liabilityMinor = this.currencies.toMinor(input.liabilityAmount, lc);
    else if (input.accountAmount !== undefined) {
      // 到账金额先行：用成交汇率（或授权依据）推回责任口径，残差精确保留。
      const rate = input.explicitRate ? this.fx.freezeExplicit(input.explicitRate) : auth.rate;
      const back = convertBackMinor(rate, this.currencies.toMinor(input.accountAmount, accountCurrency), this.currencies);
      liabilityMinor = back.fromMinor;
    } else liabilityMinor = remainingLiability; // 结清剩余授权

    if (liabilityMinor <= 0) throw new Error('settlement amount must be positive');
    if (liabilityMinor > remainingLiability) throw new Error('settlement exceeds authorized amount');

    // 结算汇率：默认沿用授权冻结依据；渠道给出实际成交汇率时单独冻结，差额计入汇兑差额。
    const settlementRate = input.explicitRate ? this.fx.freezeExplicit(input.explicitRate) : auth.rate;
    const converted = convertMinor(settlementRate, liabilityMinor, this.currencies);
    let accountMinor = converted.toMinor;
    let residualAbsorbed = false;
    const isFinalSlice = liabilityMinor === remainingLiability;
    const usesAuthorizationBasis = rateBasisHash(settlementRate) === rateBasisHash(auth.rate);
    if (isFinalSlice && usesAuthorizationBasis) {
      // 末笔分期吸收历次舍入残差，保证账户币种精确闭合到授权金额。
      // 成交汇率不同于授权依据时不强制闭合：差额必须作为汇兑差额暴露。
      const forcedAccountMinor = Math.abs(auth.authorizedAccount.minor) - auth.settledAccountMinor;
      if (forcedAccountMinor < 0) throw new Error('settlement schedule exceeds authorized account amount');
      // 已分期存在累计舍入残差时（即使本笔独立换算恰好相同），末笔到账金额即按授权总额强制闭合。
      residualAbsorbed = auth.carriedRoundingMinor !== 0 || forcedAccountMinor !== converted.toMinor;
      accountMinor = forcedAccountMinor;
    }
    const residual = residualAbsorbed
      ? residualForFinalSlice(settlementRate, Math.abs(auth.authorizedLiability.minor), auth.settledAccountMinor, accountMinor, this.currencies)
      : converted.residual;
    const fxDifference = this.settlementDifference(auth, settlementRate, liabilityMinor, accountMinor);
    const view = conversionView(settlementRate, { currency: lc, minor: liabilityMinor }, accountMinor, residual, {
      stage: 'settlement',
      residualAbsorbed: residualAbsorbed || undefined,
      fxDifference: fxDifference ?? undefined,
    });

    const payment = this.ledger.post(working.payments, {
      kind: 'settlement',
      amountMinor: accountMinor,
      currency: accountCurrency,
      liabilityMinor,
      liabilityCurrency: lc,
      sourceId: input.sourceId,
      authorizationRate: auth.rate,
      settlementRate,
      conversion: view,
      linkedAuthorizationSourceId: authSourceId,
    });
    this.events.append(claimId, 'payment.settled', { payment, fxDifference: fxDifference ?? undefined, residualAbsorbed }, actor, `payment:${input.sourceId}`);
    return this.claims.get(claimId);
  }

  reverse(claimId: string, input: ReverseInput, actor: string): ClaimState {
    const claim = this.claims.get(claimId);
    const retry = this.ledger.find(claim.payments, input.sourceId, 'reversal');
    if (retry) return this.claims.get(claimId);

    const original = claim.payments.find((e) => e.sourceId === input.reversesSourceId && (e.kind === 'settlement' || e.kind === 'authorization'));
    if (!original || original.status !== (original.kind === 'authorization' ? 'pending' : 'posted')) throw new Error(`cannot reverse unknown or closed source ${input.reversesSourceId}`);
    if (!original.liability) throw new Error(`original entry ${input.reversesSourceId} has no liability basis`);

    const accountCurrency = original.amount.currency;
    const lc = original.liability.currency;
    const fullOriginalMinor = Math.abs(original.amount.minor);
    const requestedAccountMinor = input.amount !== undefined ? this.currencies.toMinor(input.amount, accountCurrency) : fullOriginalMinor;
    if (requestedAccountMinor <= 0 || requestedAccountMinor > fullOriginalMinor) throw new Error('reversal amount out of original range');

    // 冲正精确回滚到原始汇率依据：账户币种与责任币种都按原始冻结事实做镜像/比例换算。
    const basis = original.authorizationRate!;
    let accountMinor = requestedAccountMinor;
    let liabilityMinor: number;
    let view: FxConversionView;
    let fxDifference: FxDifferenceRecord | undefined;

    if (requestedAccountMinor === fullOriginalMinor) {
      // 全额冲正：负镜像，账户与责任口径与原始流水逐分抵消。
      accountMinor = fullOriginalMinor;
      liabilityMinor = Math.abs(original.liability.minor);
      view = conversionView(basis, { currency: lc, minor: -liabilityMinor }, -accountMinor, negateResidual(original.conversion!.residual), {
        stage: 'reversal',
        // 若冲正的是吸收了累计残差的末笔结算，负镜像同样无法按单笔换算复核，由对账逐分抵消校验。
        residualAbsorbed: original.conversion?.residualAbsorbed || undefined,
      });
    } else {
      // 部分冲正：仍以原始冻结事实反向换算，责任口径残差精确保留。
      const back = convertBackMinor(basis, requestedAccountMinor, this.currencies);
      liabilityMinor = back.fromMinor;
      const negResidual = negateResidual(back.residual);
      view = conversionView(basis, { currency: lc, minor: -liabilityMinor }, -requestedAccountMinor, negResidual, { stage: 'reversal' });
      fxDifference = this.partialReversalDifference(original, basis, requestedAccountMinor, liabilityMinor);
    }

    const payment = this.ledger.post(claim.payments, {
      kind: 'reversal',
      amountMinor: accountMinor,
      currency: accountCurrency,
      liabilityMinor,
      liabilityCurrency: lc,
      sourceId: input.sourceId,
      authorizationRate: basis,
      settlementRate: original.settlementRate,
      conversion: view,
      // 冲正授权本身时授权没有关联键；冲正结算时才关联到授权。
      linkedAuthorizationSourceId: original.kind === 'settlement' ? original.linkedAuthorizationSourceId : undefined,
      reverses: { entryId: original.id, paymentEventId: this.eventIdFor(claimId, original) },
    });
    this.events.append(claimId, 'payment.reversed', { payment, fxDifference: fxDifference ?? undefined }, actor, `reversal:${input.sourceId}`);
    return this.claims.get(claimId);
  }

  /** 追回：追回币种可与任何既有币种不同，按追回时点冻结汇率重估回责任币种。 */
  recover(claimId: string, input: RecoverInput, actor: string): ClaimState {
    const claim = this.claims.get(claimId);
    const retry = this.ledger.find(claim.payments, input.sourceId, 'recovery');
    if (retry) return this.claims.get(claimId);

    const recoveryCurrency = input.currency.toUpperCase();
    const recoveryMinor = this.currencies.toMinor(input.amount, recoveryCurrency);
    const lc = claim.liabilityCurrency;
    const at = iso(input.at ?? new Date().toISOString());
    const rate = this.fx.freeze(recoveryCurrency, lc, at, { sourceVersion: input.sourceVersion });
    const converted = convertMinor(rate, recoveryMinor, this.currencies);
    const liabilityMinor = converted.toMinor;

    let fxDifference: FxDifferenceRecord | undefined;
    if (input.authorizationSourceId) {
      const auth = claim.authorizations.get(input.authorizationSourceId);
      if (auth) {
        // 追回按追回时点的汇率重估为责任价值；与授权依据不同本身即构成汇兑损益事件，
        // 其金额等于本次追回责任价值，在对账中与对应赔付配比后体现净损益。
        fxDifference = {
          label: 'recovery.revaluation',
          currency: lc,
          minor: rateBasisHash(rate) === rateBasisHash(auth.rate) ? 0 : liabilityMinor,
          baseline: auth.rate,
          actual: rate,
        };
      }
    }

    const view = conversionView(rate, { currency: recoveryCurrency, minor: recoveryMinor }, liabilityMinor, converted.residual, {
      stage: 'recovery',
      fxDifference: fxDifference ?? undefined,
    });
    const payment = this.ledger.post(claim.payments, {
      kind: 'recovery',
      amountMinor: recoveryMinor,
      currency: recoveryCurrency,
      liabilityMinor,
      liabilityCurrency: lc,
      sourceId: input.sourceId,
      authorizationRate: input.authorizationSourceId ? claim.authorizations.get(input.authorizationSourceId)?.rate : undefined,
      settlementRate: rate,
      conversion: view,
      linkedAuthorizationSourceId: input.authorizationSourceId,
    });
    this.events.append(claimId, 'payment.recovered', { payment, fxDifference: fxDifference ?? undefined }, actor, `recovery:${input.sourceId}`);
    return this.claims.get(claimId);
  }

  private assertWithinApproval(claim: ClaimState, lc: string, additionalLiabilityMinor: number): void {
    const used = this.ledger.liabilityBalance(claim.payments, lc);
    if (used + additionalLiabilityMinor > claim.approvedMinor) throw new Error('payment exceeds approved amount');
  }

  /** 成交汇率不同于授权依据时：到账金额按成交汇率换算回责任口径，相对授权依据的差为汇兑差额。 */
  private settlementDifference(auth: AuthorizationRecord, actual: FxRateFact, liabilityMinor: number, accountMinor: number): FxDifferenceRecord | null {
    if (rateBasisHash(actual) === rateBasisHash(auth.rate)) return null;
    const expectedAccountMinor = convertMinor(auth.rate, liabilityMinor, this.currencies).toMinor;
    // 账户口径差额 -> 用成交汇率折回责任币种（正数表示多付/不利差，汇兑损失；负数为汇兑收益）。
    const accountGap = accountMinor - expectedAccountMinor;
    const back = convertBackMinor(actual, accountGap, this.currencies);
    if (back.fromMinor === 0) return null; // 依据不同但换算结果相同时，不产生汇兑差额
    return {
      label: 'settlement.revaluation',
      currency: auth.authorizedLiability.currency,
      minor: back.fromMinor,
      baseline: auth.rate,
      actual,
    };
  }

  /** 部分冲正的折算口径差（相对于原始流水的同比例份额）。 */
  private partialReversalDifference(original: PaymentEntry, basis: FxRateFact, accountMinor: number, liabilityMinor: number): FxDifferenceRecord | undefined {
    if (!original.liability) return undefined;
    const ratio = accountMinor / Math.abs(original.amount.minor);
    const expectedLiability = Math.round(Math.abs(original.liability.minor) * ratio);
    const gap = liabilityMinor - expectedLiability;
    if (gap === 0 && rateBasisHash(basis) === rateBasisHash(original.authorizationRate!)) return undefined;
    return { label: 'reversal.rounding', currency: original.liability.currency, minor: gap, baseline: original.authorizationRate!, actual: basis };
  }

  private eventIdFor(claimId: string, entry: PaymentEntry): string {
    const event = this.events.list(claimId).find((e) => (e.payload as any)?.payment?.id === entry.id);
    if (!event) throw new Error(`no originating event for payment ${entry.id}`);
    return event.id;
  }
}
