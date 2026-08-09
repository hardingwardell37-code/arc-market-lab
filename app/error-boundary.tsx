"use client";
import {Component,type ReactNode} from "react";
type State={error:Error|null};
export default class ErrorBoundary extends Component<{children:ReactNode},State>{
 state:State={error:null};
 static getDerivedStateFromError(error:Error){return {error}}
 componentDidCatch(error:Error,info:{componentStack?:string|null}){console.error("[ErrorBoundary]",error,info.componentStack)}
 render(){
  if(this.state.error)return <div style={{minHeight:"100vh",background:"#090c0e",color:"#eef3f1",padding:24,fontFamily:"monospace",fontSize:13,whiteSpace:"pre-wrap"}}>
   <h1 style={{color:"#ff6077",fontSize:16}}>Something crashed</h1>
   <p>{this.state.error.message}</p>
   <pre style={{color:"#9aa39e",fontSize:11,overflowX:"auto"}}>{this.state.error.stack}</pre>
   <button style={{marginTop:16,background:"#b8f45c",color:"#10160b",border:0,borderRadius:4,padding:"10px 16px",fontWeight:800}} onClick={()=>this.setState({error:null})}>Try again</button>
  </div>;
  return this.props.children;
 }
}
