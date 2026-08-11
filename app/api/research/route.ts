import {NextRequest,NextResponse} from "next/server";
import {ASSET_NAMES,fetchQuote,fetchSeries,fetchNews,scrapeArticleText} from "../../lib/marketData";
import {computeVoters,combineSignal,computeConfidence,computeVolPct,buildPlan,DEFAULT_WEIGHTS,VOTER_KEYS,clampWeight,type Weights} from "../../lib/strategies";

export const dynamic = "force-dynamic";

function parseWeights(raw:string|null):Weights{
 if(!raw)return DEFAULT_WEIGHTS;
 try{
  const parsed=JSON.parse(raw);
  const weights:Weights={...DEFAULT_WEIGHTS};
  for(const key of VOTER_KEYS){const v=parsed?.[key];if(typeof v==="number"&&Number.isFinite(v))weights[key]=clampWeight(v)}
  return weights;
 }catch{return DEFAULT_WEIGHTS}
}

export async function GET(req:NextRequest){
 const symbol=req.nextUrl.searchParams.get("symbol")||"BTC-USD";
 const name=ASSET_NAMES[symbol]||symbol;
 const assetQuery=`${name} ${symbol.endsWith("-USD")?"crypto":symbol.includes("/")?"forex":"stock"}`;
 const weights=parseWeights(req.nextUrl.searchParams.get("weights"));
 const [quote,series,headlines]=await Promise.all([fetchQuote(symbol),fetchSeries(symbol,"1D"),fetchNews(symbol,assetQuery,6)]);

 if(!quote)return NextResponse.json({symbol,error:`No live quote is currently available for ${symbol}. Research needs a real price to reason from.`,generatedAt:new Date().toISOString()},{status:503});

 // Scrape full article text for the top 2 headlines. Best-effort: many publishers
 // block bots or paywall content, so a failed scrape is just skipped, never faked.
 await Promise.all(headlines.slice(0,2).map(async h=>{const text=await scrapeArticleText(h.link);if(text)h.scraped=text}));
 const scrapedCount=headlines.filter(h=>h.scraped).length;

 const closes=series.points.map(p=>p.price);
 const voters=computeVoters({closes,changePct:quote.change24h,headlines});
 const rank=combineSignal(voters,weights);
 const confidence=computeConfidence(rank.strength,quote.change24h);

 const volPct=computeVolPct(closes,quote.price);
 const plan=buildPlan(quote.price,volPct,rank.bullish);

 const trend=voters.find(v=>v.voter==="trend")!,meanReversion=voters.find(v=>v.voter==="meanReversion")!,breakout=voters.find(v=>v.voter==="breakout")!,news=voters.find(v=>v.voter==="news")!;
 const evidence=[
  `24h change: ${quote.change24h.toFixed(2)}%`,
  trend.detail,
  meanReversion.detail,
  breakout.detail,
  headlines.length?`${headlines.length} recent headlines scanned (${scrapedCount} full article${scrapedCount===1?"":"s"} read) — net tone reads ${news.detail.includes("positive")?"positive":news.detail.includes("negative")?"negative":"neutral"}`:"No recent headlines found for this asset",
 ];

 return NextResponse.json({
  symbol,
  generatedAt:new Date().toISOString(),
  dataQuality:series.marketState,
  signal:rank.bullish?"Bullish setup":"Bearish / defensive",
  confidence,
  entry:Number(plan.entry.toFixed(6)),
  stop:Number(plan.stop.toFixed(6)),
  target:Number(plan.target.toFixed(6)),
  voters,
  evidence,
  headlines,
  disclaimer:"Rule-based research combining recent price trend, momentum breakout, RSI/Bollinger mean-reversion, and headline tone (including scraped article text where the publisher allows it). Voter weights adapt from this browser's own paper-trading history. Not predictive and not financial advice.",
 },{headers:{"Cache-Control":"no-store"}});
}
