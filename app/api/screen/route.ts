import { NextResponse } from "next/server";
import { ASSET_NAMES, fetchSeries, fetchNews } from "../../lib/marketData";
import { computeVoters, computeVolPct } from "../../lib/strategies";

export const dynamic = "force-dynamic";

export async function GET() {
  const symbols = Object.keys(ASSET_NAMES);
  const rows = await Promise.all(
    symbols.map(async (symbol) => {
      const name = ASSET_NAMES[symbol];
      const query = `${name} ${symbol.endsWith("-USD") ? "crypto" : symbol.includes("/") ? "forex" : "stock"}`;
      const [series, headlines] = await Promise.all([fetchSeries(symbol, "1D"), fetchNews(symbol, query, 4)]);
      const closes = series.points.map((p) => p.price);
      const voters = computeVoters({ closes, changePct: series.changePct, headlines });
      const volPct = computeVolPct(closes, series.price);
      return {
        symbol,
        name,
        price: series.price,
        changePct: series.changePct,
        marketState: series.marketState,
        volPct,
        voters,
        headlines: headlines.slice(0, 3).map((h) => ({ title: h.title, source: h.source })),
      };
    }),
  );
  return NextResponse.json(
    { generatedAt: new Date().toISOString(), rows },
    { headers: { "Cache-Control": "no-store" } },
  );
}
