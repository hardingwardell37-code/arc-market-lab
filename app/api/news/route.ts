import {NextRequest,NextResponse} from "next/server";
import {ASSET_NAMES,fetchNews} from "../../lib/marketData";
export const dynamic = "force-dynamic";
export async function GET(req:NextRequest){
 const symbol=req.nextUrl.searchParams.get("symbol")||"BTC-USD";
 const name=ASSET_NAMES[symbol]||symbol;
 const query=`${name} ${symbol.endsWith("-USD")?"crypto":symbol.includes("/")?"forex":"stock"}`;
 const headlines=await fetchNews(symbol,query,8);
 return NextResponse.json({symbol,headlines,generatedAt:new Date().toISOString()},{headers:{"Cache-Control":"public, s-maxage=120, stale-while-revalidate=300"}})
}
