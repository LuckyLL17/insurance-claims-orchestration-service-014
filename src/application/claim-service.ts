import { EventStore } from './event-store';
import { EvidenceLedger } from '../domain/evidence';
import { PolicyCatalog } from '../domain/policy';
import { RuleEngine } from '../domain/rules';
import { FxRateBook } from '../domain/fx';
import { ClaimReportedPayload, ClaimState, DomainEvent, EvidenceRecord } from '../domain/types';
import { asMinor, newId, iso } from '../domain/ids';

export class ClaimService {
  constructor(private readonly events: EventStore, private readonly policies: PolicyCatalog, private readonly rules: RuleEngine, private readonly evidence: EvidenceLedger, private readonly fx: FxRateBook = new FxRateBook()) {}

  create(input: ClaimReportedPayload, actor: string, key?: string): ClaimState {
    const id = newId('claim');
    this.events.append(id, 'claim.reported', { ...input, lossAt: iso(input.lossAt), reportedAt: iso(input.reportedAt) }, actor, key);
    this.events.append(id, 'policy.snapshot.created', { policy: this.policies.snapshot(input.policyId, input.lossAt), ruleSnapshot: this.rules.freeze() }, 'system', `policy:${id}`);
    return this.get(id);
  }

  addEvent(id: string, type: DomainEvent['type'], payload: unknown, actor: string, key?: string, occurredAt?: string): ClaimState { this.assertExists(id); this.events.append(id, type, payload, actor, key, occurredAt); return this.get(id); }

  addEvidence(id: string, input: { kind: string; source: string; content: unknown; receivedAt?: string; supersedes?: string }, actor: string, key?: string): ClaimState {
    const claim = this.get(id); const record = this.evidence.add(input, claim.evidence); return this.addEvent(id, 'evidence.added', { evidence: record }, actor, key, input.receivedAt);
  }

  reviewEvidence(id: string, evidenceId: string, accepted: boolean, actor: string, key?: string): ClaimState {
    const claim = this.get(id); const record = this.evidence.review(evidenceId, accepted, claim.evidence); return this.addEvent(id, 'evidence.reviewed', { evidence: record }, actor, key);
  }

  /**
   * 理算批准：批准金额可按损失币种或支付账户币种提交，系统按批准时刻的有效汇率
   * 折算为保单责任币种，并把汇率快照、换算精度与舍入残差冻结进事件。
   */
  approveAdjustment(id: string, input: { amount: number; currency: string; requiredEvidence?: string[] }, actor: string, key?: string): ClaimState {
    const claim = this.get(id);
    const liabilityCurrency = claim.liabilityCurrency || claim.policy?.currency || claim.loss.currency;
    const conversion = this.fx.convert({ currency: input.currency, minor: asMinor(input.amount) }, liabilityCurrency, iso());
    return this.addEvent(id, 'adjustment.approved', {
      approvedMinor: conversion.to.minor,
      approvedCurrency: liabilityCurrency,
      requested: conversion.from,
      fx: conversion.fx,
      residualMicro: conversion.residualMicro,
      requiredEvidence: input.requiredEvidence ?? [],
    }, actor, key ?? `adjustment:${id}`);
  }

  get(id: string): ClaimState { return this.replay(id, this.events.list(id)); }
  replay(id: string, events: DomainEvent[]): ClaimState {
    const state = this.empty(id);
    for (const event of events.sort((a, b) => a.sequence - b.sequence)) this.apply(state, event);
    if (!state.policy) throw new Error(`claim ${id} has no policy snapshot`);
    return state;
  }

  private empty(id: string): ClaimState { return { id, policyId: '', status: 'reported', lossAt: '', reportedAt: '', channel: '', participants: [], loss: { currency: 'CNY', gross: 0 }, evidence: [], requiredEvidence: new Set(), completedSurveys: [], pendingDocuments: [], riskSignals: [], riskScore: 0, payments: [], approvedMinor: 0, liabilityCurrency: '', audit: [], processedEventIds: new Set(), version: 0 }; }
  private assertExists(id: string): void { if (this.events.list(id).length === 0) throw new Error(`unknown claim ${id}`); }

  private apply(state: ClaimState, event: DomainEvent): void {
    if (state.processedEventIds.has(event.id)) return; state.processedEventIds.add(event.id); state.version = event.sequence;
    const payload = event.payload as any;
    if (event.type === 'claim.reported') { state.policyId = payload.policyId; state.lossAt = payload.lossAt; state.reportedAt = payload.reportedAt; state.channel = payload.channel; state.participants = payload.participants; state.loss = payload.loss; state.liabilityCurrency = payload.loss.currency; state.status = 'reported'; }
    if (event.type === 'policy.snapshot.created') { state.policy = payload.policy; state.ruleSnapshot = payload.ruleSnapshot; state.liabilityCurrency = payload.policy.currency ?? state.liabilityCurrency; }
    if (event.type === 'evidence.added') { state.evidence = [...state.evidence.filter((e) => e.id !== payload.evidence.id), payload.evidence]; state.status = state.status === 'reported' ? 'investigating' : state.status; }
    if (event.type === 'evidence.reviewed') { state.evidence = state.evidence.map((e) => e.id === payload.evidence.id ? payload.evidence : e); }
    if (event.type === 'documents.requested') { state.pendingDocuments = [...new Set([...(state.pendingDocuments), ...(payload.kinds ?? [])])]; state.status = 'awaiting_documents'; }
    if (event.type === 'documents.received') { state.pendingDocuments = state.pendingDocuments.filter((kind) => !(payload.kinds ?? []).includes(kind)); if (!state.pendingDocuments.length) state.status = 'ready_for_adjustment'; }
    if (event.type === 'survey.completed') { state.completedSurveys = [...new Set([...state.completedSurveys, payload.taskId])]; }
    if (event.type === 'risk.assessed') { state.riskSignals = payload.signals; state.riskScore = payload.score; }
    if (event.type === 'adjustment.approved') { state.approvedMinor = payload.approvedMinor; state.approvedCurrency = payload.approvedCurrency ?? state.liabilityCurrency; state.requiredEvidence = new Set(payload.requiredEvidence); state.status = 'ready_for_adjustment'; }
    // 支付事件只追加事件中冻结的支付事实（含汇率快照），重放不访问当前汇率源
    if (event.type === 'payment.authorized' || event.type === 'payment.settled' || event.type === 'payment.reversed' || event.type === 'payment.recovered') {
      state.payments = [...state.payments, payload.payment];
      if (payload.payment.kind === 'settlement') state.status = 'partially_paid';
      if (payload.payment.kind === 'reversal') state.status = 'reopened';
    }
    if (event.type === 'claim.reopened') state.status = 'reopened';
    if (event.type === 'claim.rejected') state.status = 'rejected';
    state.audit.push({ sequence: event.sequence, eventId: event.id, type: event.type, occurredAt: event.occurredAt, actor: event.actor, summary: `${event.type} accepted` });
  }
}
