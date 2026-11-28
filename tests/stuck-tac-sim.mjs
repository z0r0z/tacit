import {riskConfig,riskFee} from '../dapp/fastbridge-risk.js';
const cfg=riskConfig({clean:0,long:500,poolExit:800,maxTotalBps:1000});
for(const useRisk of [false,true]) {
 let eth=10000n*10000n, stuck=0n, marked=0n;
 const a=100n*10000n;
 for(let i=0;i<100;i++) {
  const kind=i<5?'long':i<10?'poolExit':'clean';
  const fee=useRisk?riskFee(a,100,0,cfg,kind):a/100n;
  eth-=a-fee;
  if(kind==='clean') eth+=a; else {stuck+=a;marked+=a*(10000n-BigInt(cfg[kind]))/10000n;}
 }
 console.log({mode:useRisk?'risk':'legacy',ethereum:Number(eth)/10000,stuck:Number(stuck)/10000,markedEquity:Number(eth+marked)/10000});
}
