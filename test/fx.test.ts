import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/index';

const LOSS = { lossAt: '2026-08-01T08:00:00Z', reportedAt: '2026-08-01T09:00:00Z', channel: 'mobile', participants: [{ kind: 'person' as const, id: 'person-1' }] };

function crossBorderClaim(app: ReturnType<typeof buildApp>, loss: { currency: string; gross: number }, policyId = 'P-100') {
  return app.claims.create({ policyId, ...LOSS, loss }, 'test');
}

test('adjustment approval freezes the fx snapshot into the event and replay keeps it after rates move', () => {
  const app = buildApp();
  const claim = crossBorderClaim(app, { currency: 'USD', gross: 10000 });
  const approved = app.claims.approveAdjustment(claim.id, { amount: 9000, currency: 'USD' }, 'adjuster');
  assert.equal(approved.approvedCurrency, 'CNY');
  assert.equal(approved.approvedMinor, 9000_00 * 710 / 100); // 9000 USD @ 7.10

  app.fx.register({ pair: 'USD/CNY', rateNumerator: 720, rateDenominator: 100, source: 'treasury', sourceVersion: '2026-10', effectiveAt: '2026-10-01T00:00:00Z' });
  const replayed = app.replay.execute(claim.id).state;
  assert.equal(replayed.approvedMinor, approved.approvedMinor); // 重放只使用事件中冻结的汇率
});

test('settlement retry with the same sourceId never converts twice', () => {
  const app = buildApp();
  const claim = crossBorderClaim(app, { currency: 'USD', gross: 10000 });
  app.claims.approveAdjustment(claim.id, { amount: 63900, currency: 'CNY' }, 'adjuster');

  const settled = app.payments.settle(claim.id, { amount: 1000, currency: 'USD', sourceId: 'p-1' }, 'pay');
  assert.equal(settled.payments.length, 1);
  assert.equal(settled.payments[0].liability?.minor, 1000_00 * 710 / 100); // 710000 CNY minor
  assert.equal(settled.payments[0].fx?.sourceVersion, '2026-01');

  app.fx.register({ pair: 'USD/CNY', rateNumerator: 720, rateDenominator: 100, source: 'treasury', sourceVersion: '2026-10', effectiveAt: '2026-10-01T00:00:00Z' });
  const retried = app.payments.settle(claim.id, { amount: 1000, currency: 'USD', sourceId: 'p-1' }, 'pay');
  assert.equal(retried.payments.length, 1); // 没有重复入账
  assert.equal(app.payments.balances(claim.id).liability.settledNet, 710000); // 没有按新汇率重复换算
});

test('partial settlements across currencies and full reversal rolls back at the original rate basis', () => {
  const app = buildApp();
  const claim = crossBorderClaim(app, { currency: 'EUR', gross: 50000 });
  app.claims.approveAdjustment(claim.id, { amount: 50000, currency: 'CNY' }, 'adjuster');

  app.payments.settle(claim.id, { amount: 1000, currency: 'USD', sourceId: 'p-1' }, 'pay'); // 710000 CNY
  app.payments.settle(claim.id, { amount: 500, currency: 'EUR', sourceId: 'p-2' }, 'pay');  // 390000 CNY
  assert.equal(app.payments.balances(claim.id).liability.settledNet, 1_100_000);

  app.fx.register({ pair: 'USD/CNY', rateNumerator: 720, rateDenominator: 100, source: 'treasury', sourceVersion: '2026-10', effectiveAt: '2026-10-01T00:00:00Z' });
  const reversed = app.payments.reverse(claim.id, { sourceId: 'r-1', settlementSourceId: 'p-1' }, 'pay');
  const reversal = reversed.payments.find((p) => p.kind === 'reversal');
  assert.equal(reversal?.fx?.rateNumerator, 710); // 沿用原始冻结汇率而非当前 7.20
  assert.equal(reversal?.liability?.minor, -710000);
  assert.equal(reversal?.reversalOf, 'p-1');
  assert.equal(app.payments.balances(claim.id).liability.settledNet, 390000); // 精确回滚，只剩 EUR 结算

  // 部分冲正同样使用原始快照
  app.payments.reverse(claim.id, { sourceId: 'r-2', settlementSourceId: 'p-2', amount: 100 }, 'pay');
  assert.equal(app.payments.balances(claim.id).liability.settledNet, 390000 - 78000);
  assert.throws(() => app.payments.reverse(claim.id, { sourceId: 'r-3', settlementSourceId: 'p-2', amount: 401 }, 'pay'), /exceeds original settlement/);
});

test('recovery in the settlement currency books exchange difference against the original rate', () => {
  const app = buildApp();
  const claim = crossBorderClaim(app, { currency: 'USD', gross: 10000 });
  app.claims.approveAdjustment(claim.id, { amount: 63900, currency: 'CNY' }, 'adjuster');
  app.payments.settle(claim.id, { amount: 1000, currency: 'USD', sourceId: 'p-1' }, 'pay'); // @7.10 → 710000

  app.fx.register({ pair: 'USD/CNY', rateNumerator: 720, rateDenominator: 100, source: 'treasury', sourceVersion: '2026-10', effectiveAt: '2026-10-01T00:00:00Z' });
  const recovered = app.payments.recover(claim.id, { amount: 1000, currency: 'USD', sourceId: 'rec-1', againstSourceId: 'p-1' }, 'pay');
  const recovery = recovered.payments.find((p) => p.kind === 'recovery');
  assert.equal(recovery?.liability?.minor, -720000); // 按当前汇率入账
  assert.deepEqual(recovery?.exchangeDifference, { currency: 'CNY', minor: -10000 }); // 710000 - 720000

  const differences = app.payments.fxDifferences(claim.id);
  assert.equal(differences.totalExchangeDifferenceMinor, -10000);
  assert.equal(differences.exchangeDifferences[0].againstSourceId, 'p-1');
});

test('rounding residual is exact and deterministic in reconciliation', () => {
  const app = buildApp();
  app.fx.register({ pair: 'USD/CNY', rateNumerator: 7123456, rateDenominator: 1000000, source: 'treasury', sourceVersion: '2026-06', effectiveAt: '2026-06-01T00:00:00Z' });
  const claim = crossBorderClaim(app, { currency: 'USD', gross: 100 });
  app.claims.approveAdjustment(claim.id, { amount: 100000, currency: 'CNY' }, 'adjuster');
  const settled = app.payments.settle(claim.id, { amount: 0.01, currency: 'USD', sourceId: 'p-1' }, 'pay');
  // 1 USD minor @ 7.123456 = 7.123456 CNY minor → 7，残差 +0.123456
  assert.equal(settled.payments[0].liability?.minor, 7);
  assert.equal(settled.payments[0].residualMicro, 123456);

  const reconciliation = app.payments.reconciliation(claim.id);
  assert.equal(reconciliation.totals.residualMicroTotal, 123456);
  assert.equal(reconciliation.entries[0].fx?.rateNumerator, 7123456);
  assert.equal(app.payments.balances(claim.id).byCurrency.USD, 1);
});

test('replay reconstructs cross-currency balances purely from frozen event facts', () => {
  const app = buildApp();
  const claim = crossBorderClaim(app, { currency: 'USD', gross: 10000 }, 'P-300'); // USD 责任币种保单
  app.claims.approveAdjustment(claim.id, { amount: 9000, currency: 'USD' }, 'adjuster');
  app.payments.settle(claim.id, { amount: 500, currency: 'EUR', sourceId: 'p-1' }, 'pay'); // EUR→USD @ 1.09
  const before = app.payments.balances(claim.id);

  app.fx.register({ pair: 'EUR/USD', rateNumerator: 120, rateDenominator: 100, source: 'treasury', sourceVersion: '2026-10', effectiveAt: '2026-10-01T00:00:00Z' });
  const replayed = app.replay.execute(claim.id).state;
  assert.deepEqual(replayed.payments, app.claims.get(claim.id).payments);
  assert.deepEqual(app.payments.balances(claim.id), before); // 汇率变动不影响已冻结事实
  assert.equal(before.liabilityCurrency, 'USD');
  assert.equal(before.liability.settledNet, 500_00 * 109 / 100); // 54500 USD minor
});

test('authorization reserves approved capacity in liability currency without settling', () => {
  const app = buildApp();
  const claim = crossBorderClaim(app, { currency: 'USD', gross: 10000 });
  app.claims.approveAdjustment(claim.id, { amount: 7100, currency: 'CNY' }, 'adjuster'); // 710000 CNY minor

  const authorized = app.payments.authorize(claim.id, { amount: 500, currency: 'USD', sourceId: 'a-1' }, 'pay');
  assert.equal(authorized.payments[0].liability?.minor, 355000);
  assert.equal(app.payments.balances(claim.id).liability.authorized, 355000);
  assert.throws(() => app.payments.authorize(claim.id, { amount: 600, currency: 'USD', sourceId: 'a-2' }, 'pay'), /exceeds approved/);
  assert.throws(() => app.payments.settle(claim.id, { amount: 1000.01, currency: 'USD', sourceId: 'p-1' }, 'pay'), /exceeds approved/);
});
