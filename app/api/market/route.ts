import {NextRequest,NextResponse} from "next/server";
import {fetchSeries} from "../../lib/marketData";
export async function GET(req:NextRequest){
 const symbol=req.nextUrl.searchParams.get("symbol")||"BTC-USD",range=req.nextUrl.searchParams.get("range")||"1D";
 const result=await fetchSeries(symbol,range);
 return NextResponse.json({symbol,...result,updatedAt:new Date().toISOString()},{headers:{"Cache-Control":result.marketState==="LIVE"?"public, s-maxage=10, stale-while-revalidate=20":"public, s-maxage=15"}})
}
