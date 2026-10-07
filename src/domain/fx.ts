import { newId, iso, stableHash } from './ids';
import type { FxConversionView, MonetaryAmount, RoundingMode, RoundingResidual } from './types';

/**
 * 多币种结算的汇率领域模型。
 *
 * 关键约束：FxRateBoard 只允许在命令侧（产生事件时）读取；事件重放期间
 * blockReads() 会让任何汇率查询直接抛错。所有换算结果连同冻结的 FxRateFact
 * 一起写入事件，重放只能依据事件中的事实重新计算。
 */

export type { RoundingMode };

export class CurrencyRegistry {
  private readonly digitsByCode = new Map<string, number>();

  constructor() {
    for (const [code, digits] of [
      ['JPY', 0], ['KRW', 0], ['VND', 0],
      ['KWD', 3], ['BHD', 3], ['OMR', 3],
    ] as const) this.digitsByCode.set(code, digits);
  }

  seed(code: string, decimalDigits: number): void {
    if (!Number.isInteger(decimalDigits) || decimalDigits < 0 || decimalDigits > 6) throw new Error(`invalid precision for ${code}`);
    this.digitsByCode.set(code.toUpperCase(), decimalDigits);
  }

  decimalDigits(code: string): number { return this.digitsByCode.get(code.toUpperCase()) ?? 2; }

  toMinor(amount: number, code: string): number {
    if (!Number.isFinite(amount) || amount < 0) throw new Error('amount must be a non-negative finite number');
    return Math.round(amount * 10 ** this.decimalDigits(code));
  }
}

export interface FxQuote { from: string; to: string; rate: string; effectiveAt: string; rateType: string; }
interface FxPublication { sourceId: string; sourceVersion: string; publishedAt: string; quotes: FxQuote[]; }
export interface ResolvedFxQuote extends FxQuote { sourceId: string; sourceVersion: string; }
export interface FreezeOptions { sourceId?: string; sourceVersion?: string; rateType?: string; roundingMode?: RoundingMode; }
export interface ExplicitRate { from: string; to: string; rate: string; effectiveAt: string; sourceId: string; sourceVersion: string; rateType: string; }

export class FxRateBoard {
  private publications: FxPublication[] = [];
  private blocked = false;
  /** 诊断用：命令侧实际读取汇率源的次数（重试不应增加计数）。 */
  quoteCount = 0;

  constructor() {
    // 两期 ECB 报价，用于验证“按损失/授权时点取有效汇率”和“新版本发布不影响历史事件”。
    this.seed('ECB', '2026-09-01', [
      { from: 'USD', to: 'CNY', rate: '7.15000', effectiveAt: '2026-09-01T00:00:00Z', rateType: 'SPOT' },
      { from: 'CNY', to: 'USD', rate: '0.13986', effectiveAt: '2026-09-01T00:00:00Z', rateType: 'SPOT' },
      { from: 'CNY', to: 'EUR', rate: '0.12850', effectiveAt: '2026-09-01T00:00:00Z', rateType: 'SPOT' },
      { from: 'USD', to: 'EUR', rate: '0.91880', effectiveAt: '2026-09-01T00:00:00Z', rateType: 'SPOT' },
      { from: 'EUR', to: 'USD', rate: '1.08840', effectiveAt: '2026-09-01T00:00:00Z', rateType: 'SPOT' },
      { from: 'EUR', to: 'JPY', rate: '158.42', effectiveAt: '2026-09-01T00:00:00Z', rateType: 'SPOT' },
      { from: 'JPY', to: 'EUR', rate: '0.006312', effectiveAt: '2026-09-01T00:00:00Z', rateType: 'SPOT' },
      { from: 'CNY', to: 'JPY', rate: '20.75', effectiveAt: '2026-09-01T00:00:00Z', rateType: 'SPOT' },
      { from: 'JPY', to: 'CNY', rate: '0.04819', effectiveAt: '2026-09-01T00:00:00Z', rateType: 'SPOT' },
    ], '2026-09-01T08:00:00Z');
    this.seed('ECB', '2026-10-05', [
      { from: 'USD', to: 'CNY', rate: '7.25000', effectiveAt: '2026-10-05T00:00:00Z', rateType: 'SPOT' },
      { from: 'CNY', to: 'USD', rate: '0.13793', effectiveAt: '2026-10-05T00:00:00Z', rateType: 'SPOT' },
      { from: 'CNY', to: 'EUR', rate: '0.12500', effectiveAt: '2026-10-05T00:00:00Z', rateType: 'SPOT' },
      { from: 'USD', to: 'EUR', rate: '0.90625', effectiveAt: '2026-10-05T00:00:00Z', rateType: 'SPOT' },
      { from: 'EUR', to: 'USD', rate: '1.10345', effectiveAt: '2026-10-05T00:00:00Z', rateType: 'SPOT' },
      { from: 'EUR', to: 'JPY', rate: '154.00', effectiveAt: '2026-10-05T00:00:00Z', rateType: 'SPOT' },
      { from: 'JPY', to: 'EUR', rate: '0.006494', effectiveAt: '2026-10-05T00:00:00Z', rateType: 'SPOT' },
      { from: 'CNY', to: 'JPY', rate: '21.20', effectiveAt: '2026-10-05T00:00:00Z', rateType: 'SPOT' },
      { from: 'JPY', to: 'CNY', rate: '0.04717', effectiveAt: '2026-10-05T00:00:00Z', rateType: 'SPOT' },
    ], '2026-10-05T08:00:00Z');
  }

  seed(sourceId: string, sourceVersion: string, quotes: FxQuote[], publishedAt?: string): void {
    this.publications.push({ sourceId, sourceVersion, publishedAt: iso(publishedAt), quotes: quotes.map((q) => ({ ...q, effectiveAt: iso(q.effectiveAt) })) });
  }

  publish(sourceId: string, sourceVersion: string, quotes: FxQuote[], publishedAt?: string): void {
    if (this.publications.some((p) => p.sourceId === sourceId && p.sourceVersion === sourceVersion)) throw new Error(`fx rate version already exists: ${sourceId}@${sourceVersion}`);
    this.seed(sourceId, sourceVersion, quotes, publishedAt);
  }

  /** 事件重放期间调用：任何汇率读取都会被拒绝，重放只能使用事件中冻结的事实。 */
  blockReads<T>(fn: () => T): T {
    const previous = this.blocked; this.blocked = true;
    try { return fn(); } finally { this.blocked = previous; }
  }

  quote(from: string, to: string, at: string, options: FreezeOptions = {}): ResolvedFxQuote {
    if (this.blocked) throw new Error(`fx board reads are disabled during event replay (${from}->${to})`);
    const atMs = new Date(iso(at)).getTime();
    for (let i = this.publications.length - 1; i >= 0; i--) {
      const pub = this.publications[i];
      if (options.sourceId && pub.sourceId !== options.sourceId) continue;
      if (options.sourceVersion && pub.sourceVersion !== options.sourceVersion) continue;
      const candidates = pub.quotes
        .filter((q) => q.from === from && q.to === to && (!options.rateType || q.rateType === options.rateType) && new Date(q.effectiveAt).getTime() <= atMs)
        .sort((a, b) => new Date(b.effectiveAt).getTime() - new Date(a.effectiveAt).getTime());
      const selected = candidates[0];
      if (selected) return { ...selected, sourceId: pub.sourceId, sourceVersion: pub.sourceVersion };
    }
    throw new Error(`no fx rate ${from}->${to} effective at ${at}`);
  }

  /** 在命令侧冻结一份汇率事实。同币种返回恒等汇率（LOCAL），不读取汇率源。 */
  freeze(from: string, to: string, at: string, options: FreezeOptions = {}): import('./types').FxRateFact {
    if (from === to) return identityFact(from, at, options.roundingMode ?? 'HALF_UP');
    const resolved = this.quote(from, to, at, options);
    this.quoteCount += 1;
    return this.buildFact(resolved.from, resolved.to, resolved.rate, resolved, options.roundingMode ?? 'HALF_UP');
  }

  /** 冻结支付渠道实际成交汇率（结算时可能与授权汇率不同，由此产生汇兑差额）。 */
  freezeExplicit(rate: ExplicitRate, roundingMode: RoundingMode = 'HALF_UP'): import('./types').FxRateFact {
    if (this.blocked) throw new Error('fx board reads are disabled during event replay');
    return this.buildFact(rate.from, rate.to, rate.rate, rate, roundingMode);
  }

  private buildFact(from: string, to: string, rate: string, basis: { sourceId: string; sourceVersion: string; rateType: string; effectiveAt: string }, roundingMode: RoundingMode): import('./types').FxRateFact {
    const { scale } = parseRate(rate);
    const fact = {
      factId: newId('fx'), from, to, rate, rateScale: scale,
      rateDecimalDigits: scale,
      sourceId: basis.sourceId, sourceVersion: basis.sourceVersion, rateType: basis.rateType,
      effectiveAt: iso(basis.effectiveAt), frozenAt: iso(), roundingMode,
      factHash: '',
    };
    fact.factHash = rateBasisHash(fact);
    return fact;
  }
}

export function identityFact(code: string, at: string, roundingMode: RoundingMode = 'HALF_UP'): import('./types').FxRateFact {
  const fact = {
    factId: newId('fx'), from: code, to: code, rate: '1', rateScale: 0, rateDecimalDigits: 0,
    sourceId: 'LOCAL', sourceVersion: '1', rateType: 'IDENTITY',
    effectiveAt: iso(at), frozenAt: iso(), roundingMode, factHash: '',
  };
  fact.factHash = rateBasisHash(fact);
  return fact;
}

/** 汇率依据哈希：来源、版本、有效时间、报价一致即视为同一汇率依据。 */
export function rateBasisHash(fact: import('./types').FxRateFact): string {
  return stableHash({ from: fact.from, to: fact.to, rate: fact.rate, rateScale: fact.rateScale, sourceId: fact.sourceId, sourceVersion: fact.sourceVersion, rateType: fact.rateType, effectiveAt: fact.effectiveAt });
}

export function parseRate(rate: string): { mantissa: bigint; scale: number } {
  if (!/^\d+(\.\d+)?$/.test(rate)) throw new Error(`invalid fx rate: ${rate}`);
  const [int, frac = ''] = rate.split('.');
  return { mantissa: BigInt(int + frac), scale: frac.length };
}

function powerTen(exp: number): bigint { return 10n ** BigInt(exp); }

function divideRounded(num: bigint, den: bigint, mode: RoundingMode): { q: bigint; remainder: bigint } {
  const q = num / den; const r = num % den;
  if (r === 0n) return { q, remainder: 0n };
  const twice = r * 2n;
  const up = mode === 'HALF_UP' ? twice >= den : twice > den || (twice === den && q % 2n === 1n);
  return { q: up ? q + 1n : q, remainder: up ? r - den : r };
}

function renderRational(num: bigint, den: bigint): string {
  for (let k = 0; k <= 40; k++) {
    const scale = powerTen(k);
    if (scale % den === 0n) {
      const scaled = num * (scale / den);
      const neg = scaled < 0n; const digits = (neg ? -scaled : scaled).toString().padStart(k + 1, '0');
      if (k === 0) return neg ? `-${digits}` : digits;
      return `${neg ? '-' : ''}${digits.slice(0, -k)}.${digits.slice(-k)}`.replace(/0+$/, '').replace(/\.$/, '');
    }
  }
  return `${num}/${den}`;
}

function buildResidual(num: bigint, den: bigint, rounded: bigint, mode: RoundingMode): RoundingResidual {
  const residualNumerator = rounded * den - num; // rounded - exact，单位为目标币种最小单位的 1/den
  return {
    mode,
    exactMinor: renderRational(num, den),
    roundedMinor: rounded.toString(),
    residualNumerator: residualNumerator.toString(),
    residualDenominator: den.toString(),
  };
}

/**
 * 按冻结事实把 from 币种最小单位金额换算为 to 币种最小单位。
 * to.minor = from.minor * rate * 10^(dTo) / 10^(rateScale + dFrom)，全程 bigint 精确运算。
 */
export function convertMinor(fact: import('./types').FxRateFact, fromMinor: number, currencies: CurrencyRegistry): { toMinor: number; residual: RoundingResidual } {
  const sign = fromMinor < 0 ? -1 : 1;
  const abs = BigInt(Math.abs(fromMinor));
  const { mantissa, scale } = parseRate(fact.rate);
  const dFrom = currencies.decimalDigits(fact.from);
  const dTo = currencies.decimalDigits(fact.to);
  const num = abs * mantissa * powerTen(dTo);
  const den = powerTen(scale + dFrom);
  const { q } = divideRounded(num, den, fact.roundingMode);
  const residual = buildResidual(num * BigInt(sign), den, q * BigInt(sign), fact.roundingMode);
  return { toMinor: sign * Number(q), residual };
}

/** 反向换算（结算金额以支付账户币种申报时，推回责任币种），残差以分数形式精确保留。 */
export function convertBackMinor(fact: import('./types').FxRateFact, toMinor: number, currencies: CurrencyRegistry): { fromMinor: number; residual: RoundingResidual } {
  const sign = toMinor < 0 ? -1 : 1;
  const abs = BigInt(Math.abs(toMinor));
  const { mantissa, scale } = parseRate(fact.rate);
  const dFrom = currencies.decimalDigits(fact.from);
  const dTo = currencies.decimalDigits(fact.to);
  const num = abs * powerTen(scale + dFrom);
  const den = mantissa * powerTen(dTo);
  const { q } = divideRounded(num, den, fact.roundingMode);
  const residual = buildResidual(num * BigInt(sign), den, q * BigInt(sign), fact.roundingMode);
  return { fromMinor: sign * Number(q), residual };
}

/**
 * 末笔分期吸收累计舍入残差：精确值为授权总额的精确账户金额减去已入账整数金额，
 * 舍入值为强制到账金额；这样末笔残差恰好抵消前序各笔残差。
 */
export function residualForFinalSlice(fact: import('./types').FxRateFact, totalLiabilityMinor: number, settledAccountMinor: number, forcedToMinor: number, currencies: CurrencyRegistry): RoundingResidual {
  const { mantissa, scale } = parseRate(fact.rate);
  const dFrom = currencies.decimalDigits(fact.from);
  const dTo = currencies.decimalDigits(fact.to);
  const numExact = BigInt(totalLiabilityMinor) * mantissa * powerTen(dTo);
  const den = powerTen(scale + dFrom);
  const numFinal = numExact - BigInt(settledAccountMinor) * den;
  return buildResidual(numFinal, den, BigInt(forcedToMinor), fact.roundingMode);
}

export function negateResidual(residual: RoundingResidual): RoundingResidual {
  const neg = (value: string) => value.startsWith('-') ? value.slice(1) : value === '0' ? value : `-${value}`;
  return {
    mode: residual.mode,
    exactMinor: neg(residual.exactMinor),
    roundedMinor: neg(residual.roundedMinor),
    residualNumerator: (-BigInt(residual.residualNumerator)).toString(),
    residualDenominator: residual.residualDenominator,
  };
}

export function conversionView(fact: import('./types').FxRateFact, from: MonetaryAmount, toMinor: number, residual: RoundingResidual, extra: Partial<FxConversionView> = {}): FxConversionView {
  return {
    fact,
    from,
    to: { currency: fact.to, minor: toMinor },
    residual,
    ...extra,
  };
}

/** 重放时依据事件中冻结的事实重新计算，证明换算结果只依赖冻结事实而非当前汇率。 */
export function verifyFrozenConversion(view: FxConversionView, currencies: CurrencyRegistry): void {
  if (rateBasisHash(view.fact) !== view.fact.factHash) throw new Error(`fx fact hash mismatch for ${view.fact.factId}`);
  // 末笔分期吸收残差：到账金额由授权计划轧差决定，闭合性由 FxReconciler 校验。
  // 其全额冲正是精确负镜像，同样豁免单笔换算复核，由冲正回滚校验保证逐分抵消。
  if (view.residualAbsorbed) return;
  const recomputed = convertMinor(view.fact, view.from.minor, currencies);
  if (recomputed.toMinor !== view.to.minor) throw new Error(`frozen fx conversion mismatch: ${view.fact.from}->${view.fact.to} fact ${view.fact.factId}`);
}
