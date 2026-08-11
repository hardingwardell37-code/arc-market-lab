export const ASSET_NAMES: Record<string, string> = {
  "BTC-USD": "Bitcoin",
  "ETH-USD": "Ethereum",
  "SOL-USD": "Solana",
  "XRP-USD": "XRP",
  "ADA-USD": "Cardano",
  "LINK-USD": "Chainlink",
  "DOGE-USD": "Dogecoin",
  "LTC-USD": "Litecoin",
  AAPL: "Apple",
  NVDA: "NVIDIA",
  SPY: "S&P 500 ETF",
  QQQ: "Nasdaq 100 ETF",
  "EUR/USD": "Euro / US Dollar",
};

const FALLBACK_PRICE: Record<string, number> = {
  "BTC-USD": 64735.99,
  "ETH-USD": 3128.44,
  "SOL-USD": 154.28,
  "XRP-USD": 0.5836,
  "ADA-USD": 0.3986,
  "LINK-USD": 13.28,
  "DOGE-USD": 0.10998,
  "LTC-USD": 85.95,
  AAPL: 229.35,
  NVDA: 182.7,
  SPY: 532.91,
  QQQ: 472.23,
  "EUR/USD": 1.1642,
};

export type SeriesPoint = { time: number; price: number };
export type MarketState = "LIVE" | "SIMULATED";
export type SeriesResult = {
  points: SeriesPoint[];
  price: number;
  changePct: number;
  marketState: MarketState;
  provider?: string;
};

// Twelve Data's account dashboard (Basic 8 plan) confirmed the actual constraint: 8 API
// credits per MINUTE, not a daily cap - daily usage was nowhere near exhausted. The prior
// cache alone doesn't help when 5 different non-crypto symbols (AAPL/NVDA/SPY/QQQ/EUR-USD)
// get fetched together in one burst (a single /api/screen scan, or the market poll fanning
// out across the watchlist) - that's 5 distinct cache keys, each a fresh call, easily
// stacking past 8/minute the moment more than one poller's burst lands in the same window.
// A serializing queue with a fixed minimum gap between actual upstream calls is what
// actually respects a per-minute cap; the cache still avoids re-fetching the same symbol
// twice inside its TTL, so the two mechanisms cover different failure modes.
const TWELVE_DATA_CACHE_MS = 45000;
const TWELVE_DATA_MIN_GAP_MS = 8000; // 60s / 8 credits ≈ 7.5s; padded for safety margin
const twelveDataCache = new Map<string, { data: unknown; expires: number }>();
let twelveDataChain: Promise<void> = Promise.resolve();
let twelveDataLastCallAt = 0;

function throttledTwelveData<T>(fn: () => Promise<T>): Promise<T> {
  const run = twelveDataChain.then(async () => {
    const wait = TWELVE_DATA_MIN_GAP_MS - (Date.now() - twelveDataLastCallAt);
    if (wait > 0) await new Promise((res) => setTimeout(res, wait));
    twelveDataLastCallAt = Date.now();
    return fn();
  });
  twelveDataChain = run.then(
    () => undefined,
    () => undefined,
  ); // never let one failed call block the ones queued behind it
  return run;
}

async function cachedTwelveData<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = twelveDataCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.data as T;
  const data = await throttledTwelveData(load);
  twelveDataCache.set(key, { data, expires: Date.now() + TWELVE_DATA_CACHE_MS });
  return data;
}

function syntheticSeries(symbol: string, base: number, step = 900): SeriesPoint[] {
  const now = Math.floor(Date.now() / 1000);
  const points: SeriesPoint[] = [];
  for (let i = 96; i >= 0; i--) {
    const wave = Math.sin((i + symbol.length) * 0.41) * 0.008 + Math.cos(i * 0.17) * 0.004;
    points.push({ time: now - i * step, price: base * (1 + wave) });
  }
  return points;
}

function rangeConfig(range: string) {
  if (range === "1H") return { granularity: 60, limit: 60, interval: "1min", step: 60 };
  if (range === "1W") return { granularity: 3600, limit: 168, interval: "1h", step: 3600 };
  return { granularity: 900, limit: 96, interval: "15min", step: 900 };
}

export async function fetchSeries(symbol: string, range = "1D"): Promise<SeriesResult> {
  const base = FALLBACK_PRICE[symbol] || 100;
  const config = rangeConfig(range);
  if (symbol.endsWith("-USD")) {
    try {
      const [ticker, candles] = await Promise.all([
        fetch(`https://api.exchange.coinbase.com/products/${symbol}/ticker`, { headers: { Accept: "application/json" } }),
        fetch(`https://api.exchange.coinbase.com/products/${symbol}/candles?granularity=${config.granularity}`, { headers: { Accept: "application/json" } }),
      ]);
      if (!ticker.ok || !candles.ok) throw new Error("feed unavailable");
      const t = (await ticker.json()) as { price: string };
      const rows = (await candles.json()) as number[][];
      const points = rows.slice(0, config.limit).reverse().map((x) => ({ time: x[0], price: x[4] }));
      const price = Number(t.price);
      const previous = points[0]?.price || price;
      return { points, price, changePct: previous ? ((price - previous) / previous) * 100 : 0, marketState: "LIVE" };
    } catch {}
  }
  const twelveKey = process.env.TWELVE_DATA_API_KEY;
  if (twelveKey && !symbol.endsWith("-USD")) {
    try {
      return await cachedTwelveData(`series:${symbol}:${range}`, async () => {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const r = await fetch(
              `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${config.interval}&outputsize=${config.limit}`,
              { headers: { Authorization: `apikey ${twelveKey}`, Accept: "application/json" } },
            );
            if (!r.ok) throw new Error("provider unavailable");
            const data = (await r.json()) as { values?: Array<{ datetime: string; close: string }> };
            if (!data.values?.length) throw new Error("no series");
            const points = data.values
              .slice()
              .reverse()
              .map((x) => ({ time: Math.floor(new Date(x.datetime + "Z").getTime() / 1000), price: Number(x.close) }))
              .filter((x) => Number.isFinite(x.price));
            const price = points.at(-1)?.price || base;
            const previous = points[0]?.price || price;
            return { points, price, changePct: previous ? ((price - previous) / previous) * 100 : 0, marketState: "LIVE" as const, provider: "Twelve Data" };
          } catch {
            if (attempt === 0) await new Promise((res) => setTimeout(res, 1500));
          }
        }
        throw new Error("twelve data unavailable after retry");
      });
    } catch {}
  }
  const points = syntheticSeries(symbol, base, config.step);
  const price = points.at(-1)?.price || base;
  const previous = points[0].price;
  return { points, price, changePct: previous ? ((price - previous) / previous) * 100 : 0, marketState: "SIMULATED" };
}

export type Quote = {
  price: number;
  change24h: number;
  high24h?: number;
  low24h?: number;
  volume24h?: number;
};

export async function fetchQuote(symbol: string): Promise<Quote | null> {
  if (symbol.endsWith("-USD")) {
    try {
      const r = await fetch(`https://api.exchange.coinbase.com/products/${symbol}/stats`, { headers: { Accept: "application/json" } });
      if (!r.ok) throw new Error("source unavailable");
      const s = (await r.json()) as Record<string, string>;
      const open = Number(s.open), last = Number(s.last), high = Number(s.high), low = Number(s.low), volume = Number(s.volume);
      if (!Number.isFinite(last)) throw new Error("bad quote");
      return { price: last, change24h: open ? ((last - open) / open) * 100 : 0, high24h: high, low24h: low, volume24h: volume };
    } catch {
      return null;
    }
  }
  const twelveKey = process.env.TWELVE_DATA_API_KEY;
  if (!twelveKey) return null;
  // Twelve Data's free tier enforces a per-minute request cap and signals it with a
  // 200 OK + error-shaped JSON body (no `close` field) rather than a non-2xx status, so a
  // rejected call looks identical to "bad quote" here. cachedTwelveData collapses repeat
  // calls for the same symbol within its TTL into one upstream request (see definition
  // above), and the retry loop absorbs whatever contention still gets through that.
  try {
    return await cachedTwelveData(`quote:${symbol}`, async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const r = await fetch(`https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbol)}`, {
            headers: { Authorization: `apikey ${twelveKey}`, Accept: "application/json" },
          });
          if (!r.ok) throw new Error("provider unavailable");
          const q = (await r.json()) as Record<string, string>;
          const price = Number(q.close);
          if (!Number.isFinite(price)) throw new Error("bad quote");
          return {
            price,
            change24h: Number(q.percent_change) || 0,
            high24h: Number(q.high),
            low24h: Number(q.low),
            volume24h: Number(q.volume),
          };
        } catch {
          if (attempt === 0) await new Promise((res) => setTimeout(res, 1500));
        }
      }
      throw new Error("twelve data unavailable after retry");
    });
  } catch {
    return null;
  }
}

export type Headline = { title: string; link: string; source: string; publishedAt: string; description?: string; scraped?: string };

function decodeEntities(s: string) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .trim();
}

function stripHtml(s: string) {
  return decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

const YAHOO_TICKER: Record<string, string> = { "EUR/USD": "EURUSD=X" };

/** Yahoo Finance's per-ticker feed: targeted to the exact symbol, includes a real
 *  description snippet, and links straight to the publisher (unlike Google News'
 *  redirect links, which resolve to a JS-rendered shell and can't be scraped). */
async function fetchYahooNews(symbol: string, limit: number): Promise<Headline[]> {
  const ticker = YAHOO_TICKER[symbol] || symbol;
  try {
    const res = await fetch(`https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(ticker)}&region=US&lang=en-US`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ArcMarketLab/1.0)" },
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const items = xml.split("<item>").slice(1);
    const headlines: Headline[] = [];
    for (const raw of items) {
      const chunk = raw.split("</item>")[0];
      const title = stripHtml(chunk.match(/<title>([\s\S]*?)<\/title>/)?.[1] || "");
      const link = stripHtml(chunk.match(/<link>([\s\S]*?)<\/link>/)?.[1] || "");
      const description = stripHtml(chunk.match(/<description>([\s\S]*?)<\/description>/)?.[1] || "");
      const pubDate = chunk.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || "";
      if (!title || !link) continue;
      const parsed = pubDate ? new Date(pubDate) : new Date();
      headlines.push({
        title,
        link,
        description: description || undefined,
        source: (() => { try { return new URL(link).hostname.replace(/^www\./, ""); } catch { return "Yahoo Finance"; } })(),
        publishedAt: Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString(),
      });
      if (headlines.length >= limit) break;
    }
    return headlines;
  } catch {
    return [];
  }
}

async function fetchGoogleNews(query: string, limit: number): Promise<Headline[]> {
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; ArcMarketLab/1.0)" } });
    if (!res.ok) return [];
    const xml = await res.text();
    const items = xml.split("<item>").slice(1);
    const headlines: Headline[] = [];
    for (const raw of items) {
      const chunk = raw.split("</item>")[0];
      const title = decodeEntities(chunk.match(/<title>([\s\S]*?)<\/title>/)?.[1] || "");
      const link = decodeEntities(chunk.match(/<link>([\s\S]*?)<\/link>/)?.[1] || "");
      const pubDate = chunk.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || "";
      const source = decodeEntities(chunk.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] || "") || "Google News";
      if (!title) continue;
      const parsed = pubDate ? new Date(pubDate) : new Date();
      headlines.push({ title, link, source, publishedAt: Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString() });
      if (headlines.length >= limit) break;
    }
    return headlines;
  } catch {
    return [];
  }
}

/** Yahoo's ticker feed first (targeted, scrapable, has real descriptions);
 *  falls back to a Google News keyword search if Yahoo has nothing for this symbol. */
export async function fetchNews(symbol: string, query: string, limit = 6): Promise<Headline[]> {
  const yahoo = await fetchYahooNews(symbol, limit);
  if (yahoo.length) return yahoo;
  return fetchGoogleNews(query, limit);
}

/** Fetches a publisher article and pulls real paragraph text out of it.
 *  Best-effort: many sites block bots, paywall, or render client-side —
 *  returns null on any failure rather than guessing at content. */
export async function scrapeArticleText(url: string, maxChars = 700): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const html = await res.text();
    // Prefer paragraphs inside <article>/<main> (real body copy) over the full
    // page, which is dominated by nav menus, tickers, and footer links.
    const scoped = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)?.[1] ?? html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)?.[1] ?? html;
    const paragraphs = [...scoped.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
      .map((m) => stripHtml(m[1]))
      .filter((t) => t.length > 60 && t.split(" ").length > 8);
    if (!paragraphs.length) return null;
    const text = paragraphs.join(" ");
    return text.length > maxChars ? text.slice(0, maxChars).replace(/\s+\S*$/, "") + "…" : text;
  } catch {
    return null;
  }
}

const POSITIVE_WORDS = ["surge", "surges", "rally", "rallies", "gain", "gains", "soar", "soars", "record", "beat", "beats", "upgrade", "upgrades", "bullish", "climb", "climbs", "jump", "jumps", "strong", "growth", "breakout", "outperform", "rebound", "rises", "rise"];
const NEGATIVE_WORDS = ["crash", "crashes", "plunge", "plunges", "drop", "drops", "falls", "fall", "miss", "misses", "downgrade", "downgrades", "bearish", "selloff", "sink", "sinks", "slump", "weak", "recession", "fear", "fears", "lawsuit", "probe", "hack", "fraud", "layoffs", "warns", "warning"];

export function scoreHeadlines(headlines: Headline[]): number {
  let score = 0;
  for (const h of headlines) {
    const t = `${h.title} ${h.description || ""} ${h.scraped || ""}`.toLowerCase();
    for (const w of POSITIVE_WORDS) if (t.includes(w)) score++;
    for (const w of NEGATIVE_WORDS) if (t.includes(w)) score--;
  }
  return score;
}

export function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function rsi(values: number[], period = 14): number | null {
  if (values.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  if (loss === 0) return 100;
  const rs = gain / loss;
  return 100 - 100 / (1 + rs);
}
