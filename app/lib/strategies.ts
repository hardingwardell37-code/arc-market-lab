import { sma, rsi, scoreHeadlines, type Headline } from "./marketData";

export const VOTER_KEYS = ["trend", "breakout", "meanReversion", "news"] as const;
export type VoterKey = (typeof VOTER_KEYS)[number];
export type Weights = Record<VoterKey, number>;

export const DEFAULT_WEIGHTS: Weights = { trend: 1, breakout: 1, meanReversion: 1, news: 1 };
export const WEIGHT_MIN = 0.25;
export const WEIGHT_MAX = 3;
export const WEIGHT_STEP = 1.08;
export const PREDICTION_HORIZON_MS = 48 * 60 * 60 * 1000;

export type VoterOutput = { voter: VoterKey; vote: -1 | 0 | 1; detail: string };

export function trendVoter(closes: number[], fallbackChangePct: number): VoterOutput {
  const sma10 = sma(closes, 10);
  const sma30 = sma(closes, 30);
  if (sma10 != null && sma30 != null) {
    const bullish = sma10 > sma30;
    return {
      voter: "trend",
      vote: bullish ? 1 : -1,
      detail: `10-period average is ${bullish ? "above" : "below"} the 30-period average (${sma10.toFixed(2)} vs ${sma30.toFixed(2)}), a ${bullish ? "bullish" : "bearish"} trend read`,
    };
  }
  if (Number.isFinite(fallbackChangePct) && fallbackChangePct !== 0) {
    return {
      voter: "trend",
      vote: fallbackChangePct > 0 ? 1 : -1,
      detail: "Not enough recent history for a moving-average read; falling back to 24h change direction",
    };
  }
  return { voter: "trend", vote: 0, detail: "Not enough recent history yet for a trend read" };
}

export function breakoutVoter(closes: number[], period = 20): VoterOutput {
  if (closes.length < period + 1) {
    return { voter: "breakout", vote: 0, detail: "Not enough history for a breakout read" };
  }
  const window = closes.slice(-period - 1, -1);
  const hi = Math.max(...window);
  const lo = Math.min(...window);
  const last = closes.at(-1)!;
  if (last > hi) {
    return { voter: "breakout", vote: 1, detail: `New ${period}-period high — breakout above recent resistance (${hi.toFixed(2)})` };
  }
  if (last < lo) {
    return { voter: "breakout", vote: -1, detail: `New ${period}-period low — breakdown below recent support (${lo.toFixed(2)})` };
  }
  return { voter: "breakout", vote: 0, detail: `Trading inside its ${period}-period range (${lo.toFixed(2)}-${hi.toFixed(2)})` };
}

function bollinger(closes: number[], period = 20, mult = 2): { upper: number; lower: number } | null {
  if (closes.length < period) return null;
  const window = closes.slice(-period);
  const mean = window.reduce((a, b) => a + b, 0) / period;
  const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  const stdev = Math.sqrt(variance);
  return { upper: mean + mult * stdev, lower: mean - mult * stdev };
}

export function meanReversionVoter(closes: number[]): VoterOutput {
  const rsi14 = rsi(closes, 14);
  const bands = bollinger(closes, 20, 2);
  const price = closes.at(-1);
  const notes: string[] = [];
  let vote = 0;
  if (rsi14 != null) {
    if (rsi14 < 30) { vote = 1; notes.push(`RSI 14 is ${rsi14.toFixed(1)} (oversold)`); }
    else if (rsi14 > 70) { vote = -1; notes.push(`RSI 14 is ${rsi14.toFixed(1)} (overbought)`); }
    else notes.push(`RSI 14 is ${rsi14.toFixed(1)} (neutral)`);
  }
  if (bands && price != null) {
    if (price <= bands.lower) { vote = vote >= 0 ? 1 : vote; notes.push("price at/below lower Bollinger band"); }
    else if (price >= bands.upper) { vote = vote <= 0 ? -1 : vote; notes.push("price at/above upper Bollinger band"); }
  }
  if (!notes.length) return { voter: "meanReversion", vote: 0, detail: "RSI/Bollinger unavailable for this symbol right now" };
  return { voter: "meanReversion", vote: vote as -1 | 0 | 1, detail: notes.join(", ") };
}

export function newsVoter(headlines: Headline[]): VoterOutput {
  if (!headlines.length) return { voter: "news", vote: 0, detail: "No recent headlines found for this asset" };
  const score = scoreHeadlines(headlines);
  return {
    voter: "news",
    vote: score > 0 ? 1 : score < 0 ? -1 : 0,
    detail: `${headlines.length} recent headlines scanned — net tone reads ${score > 0 ? "positive" : score < 0 ? "negative" : "neutral"}`,
  };
}

export function computeVoters(input: { closes: number[]; changePct: number; headlines: Headline[] }): VoterOutput[] {
  return [
    trendVoter(input.closes, input.changePct),
    breakoutVoter(input.closes),
    meanReversionVoter(input.closes),
    newsVoter(input.headlines),
  ];
}

export function combineSignal(voters: VoterOutput[], weights: Weights): { bullish: boolean; confidence: number; weightedScore: number; strength: number } {
  let weightedScore = 0;
  let weightSum = 0;
  for (const v of voters) {
    if (v.vote === 0) continue;
    const w = weights[v.voter] ?? 1;
    weightedScore += v.vote * w;
    weightSum += w;
  }
  const bullish = weightedScore >= 0;
  const strength = weightSum ? Math.min(1, Math.abs(weightedScore) / weightSum) : 0;
  return { bullish, confidence: 0, weightedScore, strength };
}

export function computeConfidence(strength: number, changePct: number): number {
  return Math.max(42, Math.min(88, Math.round(50 + strength * 30 + Math.min(8, Math.abs(changePct || 0)))));
}

export function computeVolPct(closes: number[], price: number): number {
  const recent = closes.slice(-20);
  const mean = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : price;
  const variance = recent.length ? recent.reduce((a, b) => a + (b - mean) ** 2, 0) / recent.length : 0;
  const stdev = Math.sqrt(variance) || price * 0.01;
  return Math.min(0.035, Math.max(0.004, stdev / price));
}

export function buildPlan(price: number, volPct: number, bullish: boolean): { entry: number; stop: number; target: number } {
  return {
    entry: price * (bullish ? 1 - volPct * 0.4 : 1 + volPct * 0.4),
    stop: price * (bullish ? 1 - volPct * 1.6 : 1 + volPct * 1.6),
    target: price * (bullish ? 1 + volPct * 2.2 : 1 - volPct * 2.2),
  };
}

export function clampWeight(w: number): number {
  return Math.max(WEIGHT_MIN, Math.min(WEIGHT_MAX, w));
}

export function updateWeights(weights: Weights, voters: VoterOutput[], bullishCallTaken: boolean, outcome: "win" | "loss"): Weights {
  const next: Weights = { ...weights };
  const calldir = bullishCallTaken ? 1 : -1;
  for (const v of voters) {
    if (v.vote === 0) continue;
    const agreed = v.vote === calldir;
    const win = outcome === "win";
    const nudgeUp = (agreed && win) || (!agreed && !win);
    const current = next[v.voter] ?? 1;
    next[v.voter] = clampWeight(nudgeUp ? current * WEIGHT_STEP : current / WEIGHT_STEP);
  }
  return next;
}

export type PredictionRecord = {
  id: string;
  symbol: string;
  createdAt: number;
  expiresAt: number;
  price: number;
  bullish: boolean;
  entry: number;
  stop: number;
  target: number;
  voters: VoterOutput[];
  status: "pending" | "win" | "loss" | "expired";
  resolvedAt?: number;
  resolvedPrice?: number;
};

export function resolvePrediction(pred: PredictionRecord, currentPrice: number | undefined, now: number): PredictionRecord {
  if (pred.status !== "pending" || currentPrice == null || !Number.isFinite(currentPrice)) return pred;
  const hitTarget = pred.bullish ? currentPrice >= pred.target : currentPrice <= pred.target;
  const hitStop = pred.bullish ? currentPrice <= pred.stop : currentPrice >= pred.stop;
  if (hitTarget) return { ...pred, status: "win", resolvedAt: now, resolvedPrice: currentPrice };
  if (hitStop) return { ...pred, status: "loss", resolvedAt: now, resolvedPrice: currentPrice };
  if (now > pred.expiresAt) return { ...pred, status: "expired", resolvedAt: now, resolvedPrice: currentPrice };
  return pred;
}

export function resolveAllPredictions(
  predictions: PredictionRecord[],
  weights: Weights,
  priceLookup: (symbol: string) => number | undefined,
  now: number,
): { predictions: PredictionRecord[]; weights: Weights } {
  let nextWeights = weights;
  const nextPredictions = predictions.map((p) => {
    if (p.status !== "pending") return p;
    const resolved = resolvePrediction(p, priceLookup(p.symbol), now);
    if (resolved !== p && (resolved.status === "win" || resolved.status === "loss")) {
      nextWeights = updateWeights(nextWeights, resolved.voters, resolved.bullish, resolved.status);
    }
    return resolved;
  });
  const fourteenDaysAgo = now - 14 * 24 * 60 * 60 * 1000;
  const pruned = nextPredictions
    .filter((p) => p.status === "pending" || (p.resolvedAt ?? 0) > fourteenDaysAgo)
    .slice(-500);
  return { predictions: pruned, weights: nextWeights };
}

export function planPredictions(
  rows: Array<{ symbol: string; price: number; bullish: boolean; entry: number; stop: number; target: number; voters: VoterOutput[] }>,
  existing: PredictionRecord[],
  now: number,
  horizonMs = PREDICTION_HORIZON_MS,
): PredictionRecord[] {
  const bySymbolPending = new Map<string, PredictionRecord>();
  for (const p of existing) if (p.status === "pending") bySymbolPending.set(p.symbol, p);
  const additions: PredictionRecord[] = [];
  for (const row of rows) {
    const pending = bySymbolPending.get(row.symbol);
    if (pending && pending.bullish === row.bullish) continue;
    additions.push({
      id: `${row.symbol}-${now}-${Math.random().toString(36).slice(2, 8)}`,
      symbol: row.symbol,
      createdAt: now,
      expiresAt: now + horizonMs,
      price: row.price,
      bullish: row.bullish,
      entry: row.entry,
      stop: row.stop,
      target: row.target,
      voters: row.voters,
      status: "pending",
    });
  }
  if (!additions.length) return existing;
  return [...existing, ...additions].slice(-500);
}
