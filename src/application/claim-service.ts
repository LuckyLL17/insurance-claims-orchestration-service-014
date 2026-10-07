import { EventStore } from './event-store';
import { EvidenceLedger } from '../domain/evidence';
import { PolicyCatalog } from '../domain/policy';
import { RuleEngine } from '../domain/rules';
import {
  AuthorizationRecord, ClaimReportedPayload, ClaimState, DomainEvent,
  FxConversionView, FxDifferenceRecord, MonetaryAmount, PaymentEntry,
} from '../domain/types';
import { newId, iso } from '../domain/ids';
import { conversionView, convertMinor, CurrencyRegistry, FxRateBoard, verifyFrozenConversion } from '../domain/fx';

export class ClaimService {
  constructor(
    private readonly events: EventStore,
    private readonly policies: PolicyCatalog,
    private readonly rules: RuleEngine,
    private readonly evidence: EvidenceLedger,
    private readonly fx: FxRateBoard,
    private readonly currencies: CurrencyRegistry,
  ) {}

  create(input: ClaimReportedPayload, actor: string, key?: string): ClaimState {
    const id = newId('claim');
    this.events.append(id, 'claim.reported', { ...input, lossAt: iso(input.lossAt), reportedAt: iso(input.reportedAt) }, actor, key);
    const policy = this.policies.snapshot(input.policyId, input.lossAt);
    const ruleSnapshot = this.rules.freeze();
    // 责任快照：冻结损失币种 -> 保单责任币种的汇率事实。损失金额按此快照换算为责任口径。
    const lossMinor = this.currencies.toMinor(input.loss.gross, input.loss.currency);
    const fact = this.fx.freeze(input.loss.currency, policy.currency, input.lossAt, { rateType: 'SPOT' });
    const converted = convertMinor(fact, lossMinor, this.currencies);
    const lossConversion = conversionView(
      fact,
      { currency: input.loss.currency, minor: lossMinor },
      converted.toMinor,
      converted.residual,
      { stage: 'liability_snapshot' },
    );
    this.events.append(id, 'policy.snapshot.created', { policy, ruleSnapshot, lossConversion }, 'system', `policy:${id}`);
    return this.get(id);
  }

  addEvent(id: string, type: DomainEvent['type'], payload: unknown, actor: string, key?: string, occurredAt?: string): ClaimState { this.assertExists(id); this.events.append(id, type, payload, actor, key, occurredAt); return this.get(id); }

  addEvidence(id: string, input: { kind: string; source: string; content: unknown; receivedAt?: string; supersedes?: string }, actor: string, key?: string): ClaimState {
    const claim = this.get(id); const record = this.evidence.add(input, claim.evidence); return this.addEvent(id, 'evidence.added', { evidence: record }, actor, key, input.receivedAt);
  }

  reviewEvidence(id: string, evidenceId: string, accepted: boolean, actor: string, key?: string): ClaimState {
    const claim = this.get(id); const record = this.evidence.review(evidenceId, accepted, claim.evidence); return this.addEvent(id, 'evidence.reviewed', { evidence: record }, actor, key);
  }

  /** 理算批准：在责任币种口径核定金额，并把损失->责任的快照换算作为依据写入事件。 */
  approveAdjustment(id: string, actor: string, key?: string): ClaimState {
    const claim = this.get(id);
    if (claim.status === 'rejected') throw new Error('rejected claim cannot be adjusted');
    if (!claim.policy || !claim.ruleSnapshot || !claim.lossConversion) throw new Error('claim is missing the liability snapshot');
    const decision = this.rules.evaluate(claim, claim.ruleSnapshot, claim.grossLiabilityMinor);
    if (decision.reasons.length) throw new Error(`adjustment blocked: ${decision.reasons.join('; ')}`);
    const approvedLiability: MonetaryAmount = { currency: claim.liabilityCurrency, minor: decision.approvedMinor };
    const grossLiability: MonetaryAmount = { currency: claim.liabilityCurrency, minor: claim.grossLiabilityMinor };
    return this.addEvent(id, 'adjustment.approved', {
      approvedMinor: decision.approvedMinor,
      approvedLiability,
      grossLiability,
      currency: claim.liabilityCurrency,
      conversion: claim.lossConversion,
      requiredEvidence: decision.requiredEvidence,
      signals: decision.signals,
      approvedAt: iso(),
    }, actor, key ?? `adjustment:${id}:${claim.version}`);
  }

  get(id: string): ClaimState {
    return this.replay(id, this.events.list(id));
  }

  replay(id: string, events: DomainEvent[]): ClaimState {
    const state = this.empty(id);
    // 重放期间汇率板只读禁用：任何阶段都不能读取当前汇率，只能用事件里冻结的事实。
    this.fx.blockReads(() => {
      for (const event of events.sort((a, b) => a.sequence - b.sequence)) this.apply(state, event);
    });
    if (!state.policy) throw new Error(`claim ${id} has no policy snapshot`);
    return state;
  }

  private empty(id: string): ClaimState {
    return {
      id, policyId: '', status: 'reported', lossAt: '', reportedAt: '', channel: '', participants: [],
      loss: { currency: 'CNY', gross: 0 }, evidence: [], requiredEvidence: new Set(), completedSurveys: [],
      pendingDocuments: [], riskSignals: [], riskScore: 0, payments: [],
      liabilityCurrency: 'CNY', grossLiabilityMinor: 0, approvedMinor: 0, approvals: [],
      authorizations: new Map(), fxDifferences: [],
      audit: [], processedEventIds: new Set(), version: 0,
    };
  }
  private assertExists(id: string): void { if (this.events.list(id).length === 0) throw new Error(`unknown claim ${id}`); }

  private verify(view: FxConversionView): void { verifyFrozenConversion(view, this.currencies); }

  private apply(state: ClaimState, event: DomainEvent): void {
    if (state.processedEventIds.has(event.id)) return; state.processedEventIds.add(event.id); state.version = event.sequence;
    const payload = event.payload as any;
    if (event.type === 'claim.reported') { state.policyId = payload.policyId; state.lossAt = payload.lossAt; state.reportedAt = payload.reportedAt; state.channel = payload.channel; state.participants = payload.participants; state.loss = payload.loss; state.status = 'reported'; }
    if (event.type === 'policy.snapshot.created') {
      state.policy = structuredClone(payload.policy); state.ruleSnapshot = structuredClone(payload.ruleSnapshot);
      if (payload.lossConversion) {
        const lossConversion = structuredClone(payload.lossConversion) as FxConversionView;
        this.verify(lossConversion);
        state.lossConversion = lossConversion;
        state.liabilityCurrency = payload.policy.currency;
        state.grossLiabilityMinor = lossConversion.to.minor;
      } else {
        // 兼容重放历史事件（单币种）：无冻结换算时损失币种视为责任币种。
        state.liabilityCurrency = payload.policy.currency ?? state.loss.currency;
        state.grossLiabilityMinor = state.loss ? this.currencies.toMinor(state.loss.gross, state.loss.currency) : 0;
      }
    }
    if (event.type === 'evidence.added') { state.evidence = [...state.evidence.filter((e) => e.id !== payload.evidence.id), payload.evidence]; state.status = state.status === 'reported' ? 'investigating' : state.status; }
    if (event.type === 'evidence.reviewed') { state.evidence = state.evidence.map((e) => e.id === payload.evidence.id ? payload.evidence : e); }
    if (event.type === 'documents.requested') { state.pendingDocuments = [...new Set([...(state.pendingDocuments), ...(payload.kinds ?? [])])]; state.status = 'awaiting_documents'; }
    if (event.type === 'documents.received') { state.pendingDocuments = state.pendingDocuments.filter((kind) => !(payload.kinds ?? []).includes(kind)); if (!state.pendingDocuments.length) state.status = 'ready_for_adjustment'; }
    if (event.type === 'survey.completed') { state.completedSurveys = [...new Set([...state.completedSurveys, payload.taskId])]; }
    if (event.type === 'risk.assessed') { state.riskSignals = payload.signals; state.riskScore = payload.score; }
    if (event.type === 'adjustment.approved') {
      const conversion = structuredClone(payload.conversion) as FxConversionView;
      this.verify(conversion);
      state.approvedMinor = payload.approvedMinor;
      state.requiredEvidence = new Set(payload.requiredEvidence);
      if (payload.signals) state.riskSignals = structuredClone(payload.signals);
      state.approvals = [...state.approvals, {
        eventId: event.id,
        approvedLiability: structuredClone(payload.approvedLiability),
        grossLiability: structuredClone(payload.grossLiability),
        conversion,
        approvedAt: payload.approvedAt ?? event.occurredAt,
      }];
      state.status = 'ready_for_adjustment';
    }
    if (event.type === 'payment.authorized') {
      const payment = structuredClone(payload.payment) as PaymentEntry;
      if (payment.conversion) this.verify(payment.conversion);
      // 授权可变台账必须脱离事件 payload：apply 会更新结算进度，绝不能回写污染冻结事件。
      state.payments = [...state.payments, payment];
      state.authorizations.set(payload.authorization.sourceId, structuredClone(payload.authorization) as AuthorizationRecord);
    }
    if (event.type === 'payment.settled') {
      const payment = structuredClone(payload.payment) as PaymentEntry;
      if (payment.conversion) this.verify(payment.conversion);
      if (payload.fxDifference) this.recordDifference(state, structuredClone(payload.fxDifference) as FxDifferenceRecord);
      state.payments = [...state.payments, payment];
      if (payment.linkedAuthorizationSourceId) this.applySettlementToAuthorization(state, payment);
      state.status = this.allAuthorizedSettled(state) ? 'settled' : 'partially_paid';
    }
    if (event.type === 'payment.reversed') {
      const payment = structuredClone(payload.payment) as PaymentEntry;
      if (payment.conversion) this.verify(payment.conversion);
      if (payload.fxDifference) this.recordDifference(state, structuredClone(payload.fxDifference) as FxDifferenceRecord);
      state.payments = [...state.payments, payment];
      if (payment.linkedAuthorizationSourceId) this.applyReversalToAuthorization(state, payment);
      state.status = 'reopened';
    }
    if (event.type === 'payment.recovered') {
      const payment = structuredClone(payload.payment) as PaymentEntry;
      if (payment.conversion) this.verify(payment.conversion);
      if (payload.fxDifference) this.recordDifference(state, structuredClone(payload.fxDifference) as FxDifferenceRecord);
      state.payments = [...state.payments, payment];
    }
    if (event.type === 'claim.reopened') state.status = 'reopened';
    if (event.type === 'claim.rejected') state.status = 'rejected';
    state.audit.push({ sequence: event.sequence, eventId: event.id, type: event.type, occurredAt: event.occurredAt, actor: event.actor, summary: this.summarize(event.type, payload) });
  }

  private summarize(type: DomainEvent['type'], payload: any): string {
    if (type === 'payment.authorized') return `payment authorized ${payload.payment.liability.minor} ${payload.payment.liability.currency} @ fx ${payload.authorization.rate.sourceId}/${payload.authorization.rate.sourceVersion} rate ${payload.authorization.rate.rate} (${payload.authorization.rate.from}->${payload.authorization.rate.to})`;
    if (type === 'payment.settled') return `payment settled ${payload.payment.amount.minor} ${payload.payment.amount.currency} (liability ${payload.payment.liability.minor} ${payload.payment.liability.currency})`;
    if (type === 'payment.reversed') return `payment reversed back to original fx basis ${payload.payment.authorizationRate?.sourceVersion ?? 'n/a'}`;
    if (type === 'payment.recovered') return `recovery booked ${payload.payment.amount.minor} ${payload.payment.amount.currency}`;
    return `${type} accepted`;
  }

  private recordDifference(state: ClaimState, difference: FxDifferenceRecord): void {
    if (difference.minor === 0 && difference.baseline.factHash === difference.actual.factHash) return;
    state.fxDifferences = [...state.fxDifferences, difference];
  }

  private applySettlementToAuthorization(state: ClaimState, payment: PaymentEntry): void {
    const sourceId = payment.linkedAuthorizationSourceId!;
    const auth = state.authorizations.get(sourceId);
    if (!auth || !payment.liability) return;
    auth.settledLiabilityMinor += Math.abs(payment.liability.minor);
    auth.settledAccountMinor += Math.abs(payment.amount.minor);
    // 累计舍入残差（整数最小单位）= 逐笔独立换算后入账之和 - 已结算责任额的整体换算。
    // 分次舍入与整体舍入的差只能通过两个整数口径之差捕获；末笔分期据此强制闭合。
    const cumulativeStandalone = convertMinor(auth.rate, auth.settledLiabilityMinor, this.currencies).toMinor;
    auth.carriedRoundingMinor = auth.settledAccountMinor - cumulativeStandalone;
    if (auth.settledLiabilityMinor >= Math.abs(auth.authorizedLiability.minor)) auth.status = 'fully_settled';
  }

  private applyReversalToAuthorization(state: ClaimState, payment: PaymentEntry): void {
    const original = payment.reverses ? state.payments.find((e) => e.id === payment.reverses!.entryId) : undefined;
    // 冲正的若是授权流水本身，授权没有 linkedAuthorizationSourceId，按原始授权 sourceId 归属。
    const sourceId = payment.linkedAuthorizationSourceId ?? (original?.kind === 'authorization' ? original.sourceId : undefined);
    const auth = sourceId ? state.authorizations.get(sourceId) : undefined;
    if (!auth || !payment.liability) return;
    if (original?.kind === 'authorization' && Math.abs(payment.amount.minor) === Math.abs(original.amount.minor)) {
      original.status = 'voided';
      auth.status = 'reversed';
      return;
    }
    auth.settledLiabilityMinor -= Math.abs(payment.liability.minor);
    auth.settledAccountMinor -= Math.abs(payment.amount.minor);
    // 回滚被冲正结算贡献的累计残差：按原始依据独立换算被冲正的责任份额。
    const standalone = convertMinor(auth.rate, Math.abs(payment.liability.minor), this.currencies).toMinor;
    auth.carriedRoundingMinor -= Math.abs(payment.amount.minor) - standalone;
    // 结算被（全额或部分）冲正后，授权回到可继续结算状态；是否仍有缺口由对账计算。
    auth.status = 'open';
  }

  private allAuthorizedSettled(state: ClaimState): boolean {
    const open = [...state.authorizations.values()].filter((a) => a.status !== 'reversed');
    return open.length > 0 && open.every((a) => a.status === 'fully_settled');
  }
}
