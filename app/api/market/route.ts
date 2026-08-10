import {NextRequest,NextResponse} from "next/server";
import {fetchSeries} from "../../lib/marketData";
export const dynamic = "force-dynamic";
export async function GET(req:NextRequest){
 const symbol=req.nextUrl.searchParams.get("symbol")||"BTC-USD",range=req.nextUrl.searchParams.get("range")||"1D";
 const result=await fetchSeries(symbol,range);
 return NextResponse.json({symbol,...result,updatedAt:new Date().toISOString()},{headers:{"Cache-Control":"no-store"}})
}
