export type ClaimStatus =
  | 'reported'
  | 'investigating'
  | 'awaiting_documents'
  | 'ready_for_adjustment'
  | 'partially_paid'
  | 'settled'
  | 'reopened'
  | 'rejected';

export type ClaimEventType =
  | 'claim.reported'
  | 'policy.snapshot.created'
  | 'evidence.added'
  | 'evidence.reviewed'
  | 'survey.assigned'
  | 'survey.completed'
  | 'documents.requested'
  | 'documents.received'
  | 'risk.assessed'
  | 'adjustment.approved'
  | 'payment.authorized'
  | 'payment.settled'
  | 'payment.reversed'
  | 'payment.recovered'
  | 'claim.reopened'
  | 'claim.rejected';

export interface Participant { kind: 'person' | 'vehicle' | 'device' | 'repair_shop' | 'account'; id: string; role?: string; }
export interface MonetaryAmount { currency: string; minor: number; }
export interface LossEstimate { currency: string; gross: number; deductible?: number; liabilityShare?: number; cap?: number; }
export interface PolicyVersion { policyId: string; version: number; effectiveFrom: string; effectiveTo?: string; coverages: string[]; deductibleMinor: number; limitMinor: number; currency: string; }
export interface EvidenceRecord { id: string; kind: string; hash: string; version: number; receivedAt: string; reviewed: boolean; accepted?: boolean; source: string; supersedes?: string; }
export type RoundingMode = 'HALF_UP' | 'HALF_EVEN';

/** 冻结在事件中的汇率事实。事件重放只允许使用这里的数据，禁止读取当前汇率板。 */
export interface FxRateFact {
  factId: string;
  from: string;
  to: string;
  rate: string;
  /** 报价小数位（换算精度依据之一）。 */
  rateScale: number;
  /** 报价本身给出的精度位（汇率来源版本所声明）。 */
  rateDecimalDigits: number;
  sourceId: string;
  sourceVersion: string;
  rateType: string;
  /** 汇率有效时间：换算只接受该时间点已生效的报价。 */
  effectiveAt: string;
  frozenAt: string;
  roundingMode: RoundingMode;
  /** 来源/版本/有效时间/报价的稳定哈希，用于重放时发现事实被篡改。 */
  factHash: string;
}

/** 舍入残差：以分数形式精确保留精确金额与入账最小单位金额之间的差。 */
export interface RoundingResidual {
  mode: RoundingMode;
  exactMinor: string;
  roundedMinor: string;
  residualNumerator: string;
  residualDenominator: string;
}

export interface FxConversionView {
  fact: FxRateFact;
  from: MonetaryAmount;
  to: MonetaryAmount;
  residual: RoundingResidual;
  /** 冻结点：liability_snapshot | adjustment | authorization | settlement | reversal | recovery。 */
  stage?: string;
  /** 末笔分期吸收累计残差时为 true：到账金额按授权计划强制闭合。 */
  residualAbsorbed?: boolean;
  /** 相对授权依据产生的汇兑差额（责任币种口径）。 */
  fxDifference?: FxDifferenceRecord;
}

export interface FxDifferenceRecord {
  label: string;
  currency: string;
  minor: number;
  baseline: FxRateFact;
  actual: FxRateFact;
}

export interface PaymentEntry {
  id: string;
  kind: 'authorization' | 'settlement' | 'reversal' | 'recovery';
  amount: MonetaryAmount;
  sourceId: string;
  status: 'pending' | 'posted' | 'voided';
  createdAt: string;
  /** 授权冻结的责任币种金额（授权/结算/冲正/追回均携带）。 */
  liability?: MonetaryAmount;
  /** 授权依据（冻结事实）：部分结算与冲正都回到同一汇率依据。 */
  authorizationRate?: FxRateFact;
  /** 本笔实际换算依据（可能是支付渠道成交汇率）。 */
  settlementRate?: FxRateFact;
  conversion?: FxConversionView;
  reversesEntryId?: string;
  linkedAuthorizationSourceId?: string;
  /** 冲正/追回引用原始事件，保证精确回滚到原始汇率依据。 */
  reverses?: { entryId: string; paymentEventId: string };
}

export interface AuthorizationRecord {
  sourceId: string;
  paymentId: string;
  eventId: string;
  authorizedLiability: MonetaryAmount;
  accountCurrency: string;
  authorizedAccount: MonetaryAmount;
  rate: FxRateFact;
  status: 'open' | 'fully_settled' | 'reversed';
  createdAt: string;
  settledLiabilityMinor: number;
  settledAccountMinor: number;
  /** 已结算分期累积的舍入残差（账户币种最小单位口径，末笔强制闭合）。 */
  carriedRoundingMinor: number;
}

export interface RuleSnapshot { version: string; frozenAt: string; ruleIds: string[]; }
export interface RiskSignal { code: string; score: number; explanation: string; participants: string[]; }
export interface AuditEntry { sequence: number; eventId: string; type: ClaimEventType; occurredAt: string; actor: string; summary: string; }

export interface ClaimState {
  id: string;
  policyId: string;
  status: ClaimStatus;
  lossAt: string;
  reportedAt: string;
  channel: string;
  participants: Participant[];
  loss: LossEstimate;
  policy?: PolicyVersion;
  ruleSnapshot?: RuleSnapshot;
  evidence: EvidenceRecord[];
  requiredEvidence: Set<string>;
  completedSurveys: string[];
  pendingDocuments: string[];
  riskSignals: RiskSignal[];
  riskScore: number;
  payments: PaymentEntry[];
  /** 责任币种（保单责任币种）。 */
  liabilityCurrency: string;
  /** 损失币种 -> 责任币种的快照换算（保单/责任快照时冻结）。 */
  lossConversion?: FxConversionView;
  grossLiabilityMinor: number;
  approvedMinor: number;
  approvals: { eventId: string; approvedLiability: MonetaryAmount; grossLiability: MonetaryAmount; conversion: FxConversionView; approvedAt: string }[];
  authorizations: Map<string, AuthorizationRecord>;
  fxDifferences: FxDifferenceRecord[];
  audit: AuditEntry[];
  processedEventIds: Set<string>;
  version: number;
}

export interface DomainEvent<T = unknown> {
  id: string;
  aggregateId: string;
  type: ClaimEventType;
  occurredAt: string;
  sequence: number;
  actor: string;
  idempotencyKey?: string;
  payload: T;
}

export interface ClaimReportedPayload {
  policyId: string; lossAt: string; reportedAt: string; channel: string;
  participants: Participant[]; loss: LossEstimate;
}
