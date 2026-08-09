import type {Metadata} from "next";
import {Geist,Geist_Mono} from "next/font/google";
import "./globals.css";
import ErrorBoundary from "./error-boundary";
const sans=Geist({variable:"--font-sans",subsets:["latin"]});
const mono=Geist_Mono({variable:"--font-mono",subsets:["latin"]});
export const metadata:Metadata={title:"Arc Advanced — Paper Trading Terminal",description:"A paper trading terminal with live multi-asset market data, portfolio analytics, and research agents."};
export default function RootLayout({children}:Readonly<{children:React.ReactNode}>){return <html lang="en"><body className={`${sans.variable} ${mono.variable}`}><ErrorBoundary>{children}</ErrorBoundary></body></html>}
