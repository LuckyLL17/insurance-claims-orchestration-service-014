import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/index';

function setupCrossBorderClaim(app: ReturnType<typeof buildApp>) {
  // 损失币种 USD、保单责任币种 CNY，损失发生时 ECB 2026-09-01 版本有效（USD->CNY 7.15000）。
  const claim = app.claims.create(
    { policyId: 'P-100', lossAt: '2026-09-15T08:00:00Z', reportedAt: '2026-09-15T09:00:00Z', channel: 'mobile', participants: [], loss: { currency: 'USD', gross: 10000 } },
    'test',
  );
  const e1 = app.claims.addEvidence(claim.id, { kind: 'loss-photo', source: 'mobile', content: { x: 1 } }, 'test');
  const e2 = app.claims.addEvidence(claim.id, { kind: 'loss-photo', source: 'agent', content: { x: 2 }, supersedes: e1.evidence[0].id }, 'test');
  app.claims.reviewEvidence(claim.id, e2.evidence[0].id, true, 'adjuster');
  const d = app.claims.addEvidence(claim.id, { kind: 'repair-estimate', source: 'shop', content: { x: 3 } }, 'test');
  app.claims.reviewEvidence(claim.id, d.evidence[1].id, true, 'adjuster');
  return app.claims.approveAdjustment(claim.id, 'adjuster');
}

test('责任快照冻结损失币种到责任币种的汇率事实和换算精度', () => {
  const app = buildApp();
  const claim = setupCrossBorderClaim(app);
  assert.equal(claim.liabilityCurrency, 'CNY');
  assert.equal(claim.grossLiabilityMinor, 7_150_000); // 10000 USD * 7.15000
  const fact = claim.lossConversion!.fact;
  assert.deepEqual(
    { source: fact.sourceId, version: fact.sourceVersion, rate: fact.rate, type: fact.rateType, scale: fact.rateScale, rounding: fact.roundingMode },
    { source: 'ECB', version: '2026-09-01', rate: '7.15000', type: 'SPOT', scale: 5, rounding: 'HALF_UP' },
  );
  assert.equal(claim.approvedMinor, 7_100_000); // 71500 - 500 deductible, under 8M cap
  // 理算批准事件中冻结了同一换算依据
  assert.equal(claim.approvals[0].conversion.fact.factHash, fact.factHash);
});

test('授权冻结责任币种到支付账户币种汇率，分期结算在末笔吸收舍入残差精确闭合', () => {
  const app = buildApp();
  const claim = setupCrossBorderClaim(app);
  app.payments.authorize(claim.id, { sourceId: 'auth-1', amount: 1000, accountCurrency: 'EUR', at: '2026-09-20T10:00:00Z' }, 'pay');
  const readsAfterAuth = app.fx.quoteCount;
  // 分次舍入会产生不闭合：1 CNY->13 欧分、3 CNY->39 欧分；
  // 997 CNY 独立换算为 12799 欧分，但末笔必须强制为 12850-13-39=12798 才能精确闭合。
  app.payments.settle(claim.id, { sourceId: 's-1', authorizationSourceId: 'auth-1', liabilityAmount: 1 }, 'pay');
  app.payments.settle(claim.id, { sourceId: 's-2', authorizationSourceId: 'auth-1', liabilityAmount: 3 }, 'pay');
  app.payments.settle(claim.id, { sourceId: 's-3', authorizationSourceId: 'auth-1' }, 'pay');
  // 结算沿用授权冻结依据，不再读取汇率源
  assert.equal(app.fx.quoteCount, readsAfterAuth);
  const state = app.claims.get(claim.id);
  const slices = state.payments.filter((p) => p.kind === 'settlement').map((p) => p.amount.minor);
  assert.deepEqual(slices, [13, 39, 12_798]); // 末笔吸收 -1 欧分累计残差
  assert.equal(slices.reduce((a, b) => a + b, 0), 12_850);
  assert.equal(state.authorizations.get('auth-1')!.status, 'fully_settled');
  assert.equal(state.status, 'settled');
  assert.equal(state.payments.find((p) => p.sourceId === 's-3')!.conversion!.residualAbsorbed, true);
  const report = app.fxReporting.reconcile(claim.id);
  assert.deepEqual(report.roundingBreaches, []);
  assert.deepEqual(report.reversalBreaches, []);
  assert.equal(report.balancesByCurrency.EUR.netMinor, 12_850);
});

test('同一支付重试不会重复换算，且不产生重复流水', () => {
  const app = buildApp();
  const claim = setupCrossBorderClaim(app);
  app.payments.authorize(claim.id, { sourceId: 'auth-1', amount: 100, accountCurrency: 'EUR', at: '2026-09-20T10:00:00Z' }, 'pay');
  const reads = app.fx.quoteCount;
  const input = { sourceId: 's-1', authorizationSourceId: 'auth-1' } as const;
  app.payments.settle(claim.id, { ...input }, 'pay');
  app.payments.settle(claim.id, { ...input }, 'pay'); // 重试
  app.payments.settle(claim.id, { ...input }, 'pay'); // 再次重试
  assert.equal(app.fx.quoteCount, reads); // 重试没有读取汇率板
  const state = app.claims.get(claim.id);
  assert.equal(state.payments.filter((p) => p.kind === 'settlement').length, 1);
  // 授权重试同样幂等
  app.payments.authorize(claim.id, { sourceId: 'auth-1', amount: 100, accountCurrency: 'EUR', at: '2026-10-06T10:00:00Z' }, 'pay');
  const state2 = app.claims.get(claim.id);
  assert.equal(state2.payments.filter((p) => p.kind === 'authorization').length, 1);
  assert.equal(state2.authorizations.get('auth-1')!.rate.sourceVersion, '2026-09-01'); // 未被 10 月版本替换
});

test('全额冲正按原始汇率依据精确回滚为负镜像，对账无缺口', () => {
  const app = buildApp();
  const claim = setupCrossBorderClaim(app);
  app.payments.authorize(claim.id, { sourceId: 'auth-1', amount: 1000, accountCurrency: 'EUR', at: '2026-09-20T10:00:00Z' }, 'pay');
  app.payments.settle(claim.id, { sourceId: 's-1', authorizationSourceId: 'auth-1' }, 'pay');
  app.payments.reverse(claim.id, { sourceId: 'r-1', reversesSourceId: 's-1' }, 'pay');
  const state = app.claims.get(claim.id);
  const settlement = state.payments.find((p) => p.sourceId === 's-1')!;
  const reversal = state.payments.find((p) => p.sourceId === 'r-1')!;
  assert.equal(reversal.amount.currency, settlement.amount.currency);
  assert.equal(reversal.amount.minor, -settlement.amount.minor);
  assert.equal(reversal.liability!.minor, -settlement.liability!.minor);
  assert.equal(reversal.authorizationRate!.factHash, settlement.authorizationRate!.factHash);
  assert.equal(reversal.reverses!.entryId, settlement.id);
  const report = app.fxReporting.reconcile(claim.id);
  assert.deepEqual(report.roundingBreaches, []);
  assert.deepEqual(report.reversalBreaches, []);
  assert.equal(report.balancesByCurrency.EUR.netMinor, 0);
  assert.equal(state.authorizations.get('auth-1')!.status, 'open'); // 授权可重新支付
  // 冲正重试幂等
  const entriesBefore = state.payments.length;
  app.payments.reverse(claim.id, { sourceId: 'r-1', reversesSourceId: 's-1' }, 'pay');
  assert.equal(app.claims.get(claim.id).payments.length, entriesBefore);
});

test('冲正吸收了累计残差的末笔分期后，重新结算仍能按授权总额精确闭合', () => {
  const app = buildApp();
  const claim = setupCrossBorderClaim(app);
  app.payments.authorize(claim.id, { sourceId: 'auth-1', amount: 1000, accountCurrency: 'EUR', at: '2026-09-20T10:00:00Z' }, 'pay');
  // 1 -> 13 欧分、3 -> 39 欧分、997 独立换算 12799 但被强制为 12798 吸收 -1 欧分
  app.payments.settle(claim.id, { sourceId: 's-1', authorizationSourceId: 'auth-1', liabilityAmount: 1 }, 'pay');
  app.payments.settle(claim.id, { sourceId: 's-2', authorizationSourceId: 'auth-1', liabilityAmount: 3 }, 'pay');
  app.payments.settle(claim.id, { sourceId: 's-3', authorizationSourceId: 'auth-1' }, 'pay');
  assert.equal(app.claims.get(claim.id).payments.find((p) => p.sourceId === 's-3')!.conversion!.residualAbsorbed, true);
  // 全额冲正末笔并重新结算剩余授权：重放必须接受负镜像，新末笔重新强制闭合
  app.payments.reverse(claim.id, { sourceId: 'r-3', reversesSourceId: 's-3' }, 'pay');
  app.payments.settle(claim.id, { sourceId: 's-4', authorizationSourceId: 'auth-1' }, 'pay');
  const state = app.claims.get(claim.id);
  const accountTotal = state.payments.filter((p) => p.kind === 'settlement').reduce((s, p) => s + p.amount.minor, 0)
    - state.payments.filter((p) => p.kind === 'reversal').reduce((s, p) => s + Math.abs(p.amount.minor), 0);
  assert.equal(accountTotal, 12_850);
  assert.equal(state.authorizations.get('auth-1')!.status, 'fully_settled');
  const report = app.fxReporting.reconcile(claim.id);
  assert.deepEqual(report.roundingBreaches, []);
  assert.deepEqual(report.reversalBreaches, []);
});

test('部分结算和部分冲正保留分数舍入残差并按原始依据回滚', () => {
  const app = buildApp();
  const claim = setupCrossBorderClaim(app);
  app.payments.authorize(claim.id, { sourceId: 'auth-1', amount: 1000, accountCurrency: 'EUR', at: '2026-09-20T10:00:00Z' }, 'pay');
  // CNY 300 -> EUR 38.55 恰好整分；用 100 CNY 制造残差：100*0.12850=12.85 整分；
  // 用 333 CNY: 333*0.12850 = 42.7905 -> 42.79，残差 0.0005 EUR
  app.payments.settle(claim.id, { sourceId: 's-1', authorizationSourceId: 'auth-1', liabilityAmount: 333 }, 'pay');
  const state = app.claims.get(claim.id);
  const s1 = state.payments.find((p) => p.sourceId === 's-1')!;
  assert.equal(s1.amount.minor, 4279);
  assert.notEqual(s1.conversion!.residual.residualNumerator, '0');
  // 精确值 42.7905 EUR = 4279.05 欧分，舍入到 4279 分；残差 -0.05 分 = -500000/10000000
  assert.equal(s1.conversion!.residual.exactMinor, '4279.05');
  assert.equal(s1.conversion!.residual.roundedMinor, '4279');
  assert.equal(BigInt(s1.conversion!.residual.residualNumerator), -500_000n);
  assert.equal(s1.conversion!.residual.residualDenominator, '10000000');
  // 部分冲正 20 EUR，按授权冻结依据反算回责任币种
  app.payments.reverse(claim.id, { sourceId: 'r-1', reversesSourceId: 's-1', amount: 20 }, 'pay');
  const after = app.claims.get(claim.id);
  const r1 = after.payments.find((p) => p.sourceId === 'r-1')!;
  assert.equal(r1.amount.minor, -2000);
  assert.equal(r1.authorizationRate!.factHash, s1.authorizationRate!.factHash);
  assert.ok(r1.conversion!.residual);
  const report = app.fxReporting.reconcile(claim.id);
  assert.deepEqual(report.reversalBreaches, []);
});

test('成交汇率不同于授权依据时记录汇兑差额，依据相同则为零', () => {
  const app = buildApp();
  const claim = setupCrossBorderClaim(app);
  app.payments.authorize(claim.id, { sourceId: 'auth-1', amount: 1000, accountCurrency: 'EUR', at: '2026-09-20T10:00:00Z' }, 'pay');
  // 渠道实际成交 0.13000（授权依据 0.12850）
  app.payments.settle(claim.id, {
    sourceId: 's-1', authorizationSourceId: 'auth-1',
    explicitRate: { from: 'CNY', to: 'EUR', rate: '0.13000', effectiveAt: '2026-09-21T10:00:00Z', sourceId: 'CHANNEL', sourceVersion: 'ch-1', rateType: 'DEAL' },
  }, 'pay');
  const state = app.claims.get(claim.id);
  assert.equal(state.payments.at(-1)!.amount.minor, 13_000); // 1000 CNY * 0.13
  const diff = app.fxReporting.differences(claim.id);
  assert.equal(diff.lines.length, 1);
  assert.equal(diff.lines[0].label, 'settlement.revaluation');
  assert.equal(diff.lines[0].baseline.rate, '0.12850');
  assert.equal(diff.lines[0].actual.sourceId, 'CHANNEL');
  assert.notEqual(diff.total.minor, 0);
});

test('追回可以使用第四种币种并按追回时点汇率重估回责任币种', () => {
  const app = buildApp();
  const claim = setupCrossBorderClaim(app);
  app.payments.recover(claim.id, { sourceId: 'rec-1', currency: 'JPY', amount: 10_000, at: '2026-09-25T10:00:00Z' }, 'pay');
  const state = app.claims.get(claim.id);
  const recovery = state.payments.at(-1)!;
  assert.equal(recovery.kind, 'recovery');
  assert.equal(recovery.amount.currency, 'JPY');
  assert.equal(recovery.amount.minor, -10_000); // JPY 零小数位
  assert.equal(recovery.liability!.currency, 'CNY');
  assert.equal(recovery.liability!.minor, -481_90); // 10000 * 0.04819
  assert.equal(recovery.conversion!.fact.sourceVersion, '2026-09-01');
  const balances = app.fxReporting.balances(claim.id);
  assert.equal(balances.balances.JPY.netMinor, -10_000);
});

test('事件重放只能使用冻结汇率事实：发布新版汇率后重放结果不变，且禁止读取汇率板', () => {
  const app = buildApp();
  const claim = setupCrossBorderClaim(app);
  app.payments.authorize(claim.id, { sourceId: 'auth-1', amount: 1000, accountCurrency: 'EUR', at: '2026-09-20T10:00:00Z' }, 'pay');
  app.payments.settle(claim.id, { sourceId: 's-1', authorizationSourceId: 'auth-1' }, 'pay');
  // 在重放中途“偷换”汇率板会立刻失败：blockReads 覆盖 replay
  assert.throws(() => app.fx.blockReads(() => app.fx.quote('USD', 'CNY', '2026-09-20T00:00:00Z')), /disabled during event replay/);
  // 发布新版本（显著不同的报价），事件重放结果必须保持不变
  app.fx.publish('ECB', '2026-10-07', [
    { from: 'USD', to: 'CNY', rate: '9.99000', effectiveAt: '2026-10-07T00:00:00Z', rateType: 'SPOT' },
    { from: 'CNY', to: 'EUR', rate: '9.99000', effectiveAt: '2026-10-07T00:00:00Z', rateType: 'SPOT' },
    { from: 'EUR', to: 'JPY', rate: '9.99', effectiveAt: '2026-10-07T00:00:00Z', rateType: 'SPOT' },
    { from: 'JPY', to: 'CNY', rate: '9.99999', effectiveAt: '2026-10-07T00:00:00Z', rateType: 'SPOT' },
  ], '2026-10-07T08:00:00Z');
  const replayed = app.replay.execute(claim.id).state;
  assert.equal(replayed.grossLiabilityMinor, 7_150_000);
  assert.equal(replayed.lossConversion!.fact.rate, '7.15000');
  assert.equal(replayed.authorizations.get('auth-1')!.rate.rate, '0.12850');
  assert.equal(replayed.payments.find((p) => p.sourceId === 's-1')!.amount.minor, 12_850);
  // 重放结果与实时状态一致（多次重放互不污染）
  const again = app.replay.execute(claim.id).state;
  assert.equal(again.payments.filter((p) => p.kind === 'settlement').length, 1);
  assert.equal(again.authorizations.get('auth-1')!.settledAccountMinor, 12_850);
});

test('冻结事实被篡改时重放拒绝该事件', () => {
  const app = buildApp();
  const claim = setupCrossBorderClaim(app);
  const events = app.replay.execute(claim.id).events;
  const snapshot = events.find((e) => e.type === 'policy.snapshot.created')!;
  const conversion = snapshot.payload as any;
  const originalRate = conversion.lossConversion.fact.rate;
  conversion.lossConversion.fact.rate = '8.88000';
  assert.throws(() => app.claims.replay(claim.id, [snapshot]), /fact hash mismatch/);
  conversion.lossConversion.fact.rate = originalRate;
  conversion.lossConversion.to.minor += 1;
  assert.throws(() => app.claims.replay(claim.id, [snapshot]), /frozen fx conversion mismatch/);
});

test('跨币种授权支付仍受责任币种赔付上限约束', () => {
  const app = buildApp();
  const claim = setupCrossBorderClaim(app); // 核定 7,100,000 CNY 分
  assert.throws(
    () => app.payments.authorize(claim.id, { sourceId: 'too-big', amount: 100_000, accountCurrency: 'EUR', at: '2026-09-20T10:00:00Z' }, 'pay'),
    /exceeds approved amount/,
  );
});
