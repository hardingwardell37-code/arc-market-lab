import {NextRequest,NextResponse} from "next/server";
import {ASSET_NAMES,fetchQuote,fetchSeries,fetchNews,scoreHeadlines,scrapeArticleText,sma,rsi} from "../../lib/marketData";

export const dynamic = "force-dynamic";
export async function GET(req:NextRequest){
 const symbol=req.nextUrl.searchParams.get("symbol")||"BTC-USD";
 const name=ASSET_NAMES[symbol]||symbol;
 const assetQuery=`${name} ${symbol.endsWith("-USD")?"crypto":symbol.includes("/")?"forex":"stock"}`;
 const [quote,series,headlines]=await Promise.all([fetchQuote(symbol),fetchSeries(symbol,"1D"),fetchNews(symbol,assetQuery,6)]);

 if(!quote)return NextResponse.json({symbol,error:`No live quote is currently available for ${symbol}. Research needs a real price to reason from.`,generatedAt:new Date().toISOString()},{status:503});

 // Scrape full article text for the top 2 headlines. Best-effort: many publishers
 // block bots or paywall content, so a failed scrape is just skipped, never faked.
 await Promise.all(headlines.slice(0,2).map(async h=>{const text=await scrapeArticleText(h.link);if(text)h.scraped=text}));
 const scrapedCount=headlines.filter(h=>h.scraped).length;

 const closes=series.points.map(p=>p.price);
 const sma10=sma(closes,10),sma30=sma(closes,30),rsi14=rsi(closes,14);
 const trendBullish=sma10!=null&&sma30!=null?sma10>sma30:quote.change24h>=0;
 const newsScore=scoreHeadlines(headlines);

 let votes=0,signals=0;
 signals++;if(trendBullish)votes++;else votes--;
 if(rsi14!=null){signals++;if(rsi14<40)votes++;else if(rsi14>60)votes--;}
 if(Number.isFinite(quote.change24h)&&quote.change24h!==0){signals++;if(quote.change24h>0)votes++;else votes--;}
 if(headlines.length){signals++;if(newsScore>0)votes++;else if(newsScore<0)votes--;}
 const bullish=votes>=0;
 const strength=signals?Math.abs(votes)/signals:0;
 const confidence=Math.max(42,Math.min(88,Math.round(50+strength*30+Math.min(8,Math.abs(quote.change24h||0)))));

 const recent=closes.slice(-20);
 const mean=recent.length?recent.reduce((a,b)=>a+b,0)/recent.length:quote.price;
 const variance=recent.length?recent.reduce((a,b)=>a+(b-mean)**2,0)/recent.length:0;
 const stdev=Math.sqrt(variance)||quote.price*.01;
 const volPct=Math.min(.035,Math.max(.004,stdev/quote.price));
 const entry=quote.price*(bullish?1-volPct*.4:1+volPct*.4);
 const stop=quote.price*(bullish?1-volPct*1.6:1+volPct*1.6);
 const target=quote.price*(bullish?1+volPct*2.2:1-volPct*2.2);

 const evidence=[
  `24h change: ${quote.change24h.toFixed(2)}%`,
  sma10!=null&&sma30!=null?`10-period average is ${sma10>sma30?"above":"below"} the 30-period average (${sma10.toFixed(2)} vs ${sma30.toFixed(2)}), a ${sma10>sma30?"bullish":"bearish"} trend read`:"Not enough recent history yet for a moving-average trend read",
  rsi14!=null?`RSI 14 is ${rsi14.toFixed(1)}${rsi14>65?" (overbought territory)":rsi14<35?" (oversold territory)":" (neutral)"}`:"RSI unavailable for this symbol right now",
  headlines.length?`${headlines.length} recent headlines scanned (${scrapedCount} full article${scrapedCount===1?"":"s"} read) — net tone reads ${newsScore>0?"positive":newsScore<0?"negative":"neutral"}`:"No recent headlines found for this asset",
 ];

 return NextResponse.json({
  symbol,
  generatedAt:new Date().toISOString(),
  dataQuality:series.marketState,
  signal:bullish?"Bullish setup":"Bearish / defensive",
  confidence,
  entry:Number(entry.toFixed(6)),
  stop:Number(stop.toFixed(6)),
  target:Number(target.toFixed(6)),
  evidence,
  headlines,
  disclaimer:"Rule-based research combining recent price trend, RSI, and headline tone (including scraped article text where the publisher allows it). Not predictive and not financial advice.",
 },{headers:{"Cache-Control":"no-store"}});
}
