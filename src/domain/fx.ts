import { MonetaryAmount } from './types';
import { iso } from './ids';

/**
 * 汇率换算精度：残差以 1/1_000_000 个目标币种最小单位（micro-minor）表示，
 * 保证舍入残差可以确定性求和而不引入浮点误差。
 */
export const FX_PRECISION_MICRO = 1_000_000;
export type RoundingMode = 'half-up';

export interface FxRate {
  pair: string;             // '<BASE>/<QUOTE>'，例如 'USD/CNY'
  rateNumerator: number;    // 汇率 = numerator / denominator（每单位基准币折合多少计价币）
  rateDenominator: number;
  source: string;           // 汇率来源，例如 'treasury'、'ecb'
  sourceVersion: string;    // 来源数据版本
  effectiveAt: string;      // 汇率生效时间（含）
  expiresAt?: string;       // 汇率失效时间（不含）
}

/** 冻结进事件的汇率事实：重放时只能使用它，不得重新询价。 */
export interface FxSnapshot {
  pair: string;
  rateNumerator: number;
  rateDenominator: number;
  source: string;
  sourceVersion: string;
  effectiveAt: string;
  quotedAt: string;
  rounding: RoundingMode;
  precisionMicro: number;
}

export interface FxConversion {
  from: MonetaryAmount;
  to: MonetaryAmount;
  fx: FxSnapshot | null;    // 同币种无需换算时为 null
  residualMicro: number;    // 带符号舍入残差（目标币种 micro-minor）
}

export function splitPair(pair: string): [string, string] {
  const parts = pair.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error(`invalid fx pair ${pair}`);
  return [parts[0], parts[1]];
}

function assertRateShape(rate: FxRate): void {
  if (!Number.isSafeInteger(rate.rateNumerator) || rate.rateNumerator <= 0) throw new Error('rate numerator must be a positive integer');
  if (!Number.isSafeInteger(rate.rateDenominator) || rate.rateDenominator <= 0) throw new Error('rate denominator must be a positive integer');
  iso(rate.effectiveAt);
  if (rate.expiresAt) iso(rate.expiresAt);
}

/** 用冻结的汇率快照做纯函数换算，不访问任何当前汇率源。 */
export function convertWithSnapshot(amount: MonetaryAmount, targetCurrency: string, fx: FxSnapshot): FxConversion {
  const [base, quote] = splitPair(fx.pair);
  let numerator = fx.rateNumerator;
  let denominator = fx.rateDenominator;
  if (amount.currency === base && targetCurrency === quote) { /* 正向 */ }
  else if (amount.currency === quote && targetCurrency === base) { numerator = fx.rateDenominator; denominator = fx.rateNumerator; }
  else throw new Error(`snapshot ${fx.pair} cannot convert ${amount.currency} to ${targetCurrency}`);

  const sign = amount.minor < 0 ? -1 : 1;
  const magnitude = Math.abs(amount.minor);
  const n = magnitude * numerator;
  const d = denominator;
  let to = Math.floor(n / d);
  const remainder = n - to * d;
  const roundedUp = remainder * 2 >= d;
  if (roundedUp) to += 1; // half-up
  // 残差 = 精确值 - 舍入值（目标币种 micro-minor），向上舍入时为负
  const residualMicro = Math.round((remainder * FX_PRECISION_MICRO) / d) - (roundedUp ? FX_PRECISION_MICRO : 0);
  return {
    from: { ...amount },
    to: { currency: targetCurrency, minor: sign * to },
    fx: { ...fx },
    residualMicro: sign * residualMicro,
  };
}

export class FxRateBook {
  private readonly rates: FxRate[] = [];

  register(rate: FxRate): FxRate {
    assertRateShape(rate);
    splitPair(rate.pair);
    const stored = structuredClone(rate);
    this.rates.push(stored);
    return stored;
  }

  list(pair?: string): FxRate[] { return this.rates.filter((rate) => !pair || rate.pair === pair).map((rate) => structuredClone(rate)); }

  /** 按有效时间选择汇率版本：effectiveAt <= at < expiresAt，取最新生效者。 */
  quote(pair: string, at: string, now: string = iso()): FxSnapshot {
    const [base, quoteCurrency] = splitPair(pair);
    if (base === quoteCurrency) throw new Error(`identity pair ${pair} needs no rate`);
    const direct = this.select(pair, at);
    if (direct) return this.snapshot(direct, now);
    const inverse = this.select(`${quoteCurrency}/${base}`, at);
    if (inverse) return this.snapshot(inverse, now);
    throw new Error(`no effective fx rate for ${pair} at ${at}`);
  }

  convert(amount: MonetaryAmount, targetCurrency: string, at: string, now: string = iso()): FxConversion {
    if (amount.currency === targetCurrency) return { from: { ...amount }, to: { currency: targetCurrency, minor: amount.minor }, fx: null, residualMicro: 0 };
    return convertWithSnapshot(amount, targetCurrency, this.quote(`${amount.currency}/${targetCurrency}`, at, now));
  }

  private select(pair: string, at: string): FxRate | undefined {
    const time = new Date(iso(at)).getTime();
    return this.rates
      .filter((rate) => rate.pair === pair)
      .filter((rate) => new Date(rate.effectiveAt).getTime() <= time)
      .filter((rate) => !rate.expiresAt || time < new Date(rate.expiresAt).getTime())
      .sort((a, b) => new Date(a.effectiveAt).getTime() - new Date(b.effectiveAt).getTime() || a.sourceVersion.localeCompare(b.sourceVersion))
      .at(-1);
  }

  private snapshot(rate: FxRate, now: string): FxSnapshot {
    return {
      pair: rate.pair,
      rateNumerator: rate.rateNumerator,
      rateDenominator: rate.rateDenominator,
      source: rate.source,
      sourceVersion: rate.sourceVersion,
      effectiveAt: iso(rate.effectiveAt),
      quotedAt: now,
      rounding: 'half-up',
      precisionMicro: FX_PRECISION_MICRO,
    };
  }
}
