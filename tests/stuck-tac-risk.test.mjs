import test from 'node:test';
import assert from 'node:assert/strict';
import {riskConfig,riskFee,classify,makeRiskScreen,TAC} from '../dapp/fastbridge-risk.js';
const cfg=riskConfig({clean:0,long:500,poolExit:800,maxTotalBps:1000});
const inputs=[{txid:'a',vout:0},{txid:'b',vout:1}];
const q=(out)=>({btcAsset:TAC,evmAsset:TAC,btcValue:'10000',evmAmount:String(out)});
const screen=(a,b)=>makeRiskScreen(async()=>new Map([['a:0',a],['b:1',b]]),cfg,100,0);
const clean={state:'tracked'}, long={state:'long'}, exit={state:'unprovable',through:'shielded'};
test('class fees and legacy worst class',()=>{assert.equal(riskFee(10000n,100,0,cfg,'clean'),100n);assert.equal(riskFee(10000n,100,0,cfg,'long'),600n);assert.equal(riskFee(10000n,100,0,cfg),900n)});
test('round up and cap',()=>{assert.equal(riskFee(10001n,100,0,cfg,'long'),601n);assert.throws(()=>riskFee(10000n,500,0,cfg));assert.throws(()=>riskFee(10000n,100,0,cfg,'fake'))});
test('boundary and unsupported lineage',()=>{assert.equal(classify({state:'traced',hops:253}),'clean');assert.equal(classify({state:'traced',hops:254}),'long');assert.equal(classify({state:'unprovable',through:'other'}),null)});
test('mixed notes require worst haircut',async()=>{assert.equal(await screen(clean,long)(inputs,q(9400)),null);assert.ok(await screen(clean,long)(inputs,q(9900)));assert.equal(await screen(long,exit)(inputs,q(9100)),null)});
test('unread, empty, wrong asset, overcharge, invalid payout',async()=>{assert.equal((await screen(clean,{state:'unread'})(inputs,q(9100))).retry,true);assert.ok(await screen(clean,clean)([],q(9900)));assert.ok(await screen(clean,clean)(inputs,{...q(9900),btcAsset:'x'}));assert.ok(await screen(clean,clean)(inputs,q(8000)));assert.ok(await screen(clean,clean)(inputs,q(0)))});
test('reject invalid config',()=>{assert.throws(()=>riskConfig({clean:0,long:500,poolExit:800,maxTotalBps:700}));assert.throws(()=>riskConfig({clean:0,long:-1,poolExit:800,maxTotalBps:1000}))});
test('failed vet fails closed',async()=>{const s=makeRiskScreen(async()=>{throw Error('offline')},cfg,100,0);assert.equal((await s(inputs,q(9100))).retry,true)});

// Exercise the actual service, authenticated quote and Bitcoin admission path using
// locally constructed commitments/scripts and a mocked confirmed chain. No network.
import {makeLpService, makeQuoter} from '../dapp/fastbridge-provider.js';
import {makeBtcWallet} from '../dapp/bitcoin-taproot-wallet.js';
import {deriveLock} from '../dapp/adaptor-btc-lock.js';
import {makeBtcLockOffer, legSwapId} from '../dapp/adaptor-xswap.js';
import {G, pedersenCommit} from '../dapp/bulletproofs.js';
import {bytesToHex} from '../dapp/vendor/tacit-deps.min.js';
import {makeCounter} from '../dapp/fastbridge-http.js';
import {feeOf} from '../dapp/fastbridge-price.js';
const mem = () => { const m = new Map(); return {get: async id => m.get(id), put: async r => m.set(r.id,r), list: async () => [...m.values()]}; };
const now = () => 1700000000;
const wallet = makeBtcWallet({priv:new Uint8Array(32).fill(7),hrp:'tb',fetchUtxos:async()=>[],broadcastTx:async()=>{throw Error('offline')},fetchFeeRate:async()=>1});
const claimPub=bytesToHex(wallet.prims.wallet.pub);
const params={btcAsset:TAC,evmAsset:'0x'+TAC,minAmount:1000,maxAmount:100000,feeBps:100,flatFee:0,validSecs:600,rate:{num:1,den:1},claimPub,csvBlocks:144,evmWindowSecs:14400,minConfsFor:()=>1};
function service(verdict, riskPricing=cfg) {
  const txid='11'.repeat(32), prev='22'.repeat(32), T=G.multiply(9n), locker=G.multiply(10n).toRawBytes(true).slice(1), rLock=11n;
  const spk=bytesToHex(deriveLock({prims:wallet.prims,claimerPub:wallet.prims.wallet.pub,T,lockerXonly:locker,csvBlocks:144}).spk);
  const store=mem(), quoteStore=mem(); let seen=[];
  const riskLineage=async ns=>{seen=ns;return new Map([[prev+':0',verdict]])};
  const btc={prims:wallet.prims,wallet:wallet.prims.wallet,fetchTx:async()=>({vin:[{txid:'33'.repeat(32),vout:0},{txid:prev,vout:0}],vout:[{value:546,scriptpubkey:spk}]}),status:async()=>({confirmations:1,height:1}),blockTime:async()=>now(),resolveNote:async()=>({commitment:pedersenCommit(10000n,rLock).toRawBytes(true),assetIdHex:TAC}),crossLaneBlocked:async()=>null};
  const config={claimPub,csvBlocks:144,quote:{...params,riskPricing},policy:{minAmount:1000,maxAmount:100000,minCsv:72,minConfsFor:()=>1,evmWindowSecs:14400,minClaimSecs:3600,...(riskPricing?{riskLineage}:{})}};
  const svc=makeLpService({seed:new Uint8Array(32).fill(3),btc,evm:{available:async()=>100000n},swaps:store,quoteStore,config,now});
  const counter=makeCounter((method,path,body)=>svc.handle({method,path,body}));
  const offer=q=>makeBtcLockOffer({swapId:legSwapId(prev,0),asset:TAC,value:10000n,rLock,txid,vout:0,csvBlocks:144,lockerXonly:locker,T,claimerPub:wallet.prims.wallet.pub,evm:{asset:TAC,amount:BigInt(q.evmAmount),recipient:locker,rOut:12n}});
  return {svc,counter,store,offer,seen:()=>seen,prev};
}
test('service advertises a conservative legacy fee and explicit classes use sealed amounts',async()=>{
  const w=service(clean);const info=await w.counter.info();
  const old=await w.counter.quote(10001n), low=await w.counter.quote(10000n,'clean');
  assert.equal(old.evmAmount,'9100');assert.equal(low.evmAmount,'9900');
  assert.ok(10001n-BigInt(old.evmAmount)<=feeOf(info,10001n));
  assert.equal((await w.svc.quoter.get(low.id)).evmAmount,'9900');
  await assert.rejects(w.counter.quote(10000n,'fake'),/unknown TAC risk class/);
  const tampered=low.id.slice(0,-1)+(low.id.endsWith('0')?'1':'0');assert.equal(await w.svc.quoter.get(tampered),null);
});
test('actual admission refuses a clean quote against long history, accepts a sufficiently priced valid lock',async()=>{
  const w=service(long);const cheap=await w.counter.quote(10000n,'clean');
  const rejected=await w.svc.el.receive({quoteId:cheap.id,offer:w.offer(cheap)});
  assert.equal(rejected.ok,false);assert.match(rejected.why,/does not cover/);assert.equal((await w.store.list()).length,0);
  assert.deepEqual(w.seen(),[{txid:w.prev,vout:0}]);
  const fair=await w.counter.quote(10000n,'long');const accepted=await w.svc.el.receive({quoteId:fair.id,offer:w.offer(fair)});
  assert.equal(accepted.ok,true,accepted.why);assert.equal(accepted.rec.phase,'accepted');
});
test('disabled feature preserves legacy quote and info shape',async()=>{
  const w=service(clean,null);const info=await w.counter.info();assert.equal(info.feeBps,100);assert.equal(info.flatFee,'0');assert.equal(info.riskPricing,undefined);
  const q=await w.counter.quote(10000n);assert.equal(q.evmAmount,'9900');
});
test('quoter refuses incompatible assets, rates and excessive configured fees',()=>{
  const make=over=>makeQuoter({store:mem(),now,params:{...params,riskPricing:cfg,...over}});
  assert.throws(()=>make({evmAsset:'00'.repeat(32)}),/fixed TAC/);
  assert.throws(()=>make({rate:{num:2,den:1}}),/fixed TAC/);
  assert.throws(()=>make({feeBps:300}),/ceiling/);
  assert.throws(()=>makeLpService({config:{quote:{riskPricing:cfg,btcAsset:TAC},policy:{}}}),/requires a lineage reader/);
});
