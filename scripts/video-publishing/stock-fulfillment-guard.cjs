const fs=require('fs'),path=require('path'),crypto=require('crypto');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// Re-read the canonical registry on every boundary so a newly received stock hold
// also blocks an already prepared upload. This only enforces registered holds.
function assertStockFulfillment(id,stage){
 const entry=read('outputs/video-publishing-2026-10-17/checkpoint.json').accepted_jobs.find(x=>x.video_id===id);
 if(entry)require('./aircraft-link-policy.cjs').assertAircraftLinkPolicy(id,read(entry.package),read('operations/module-execution-policy.json'));
 if(entry)require('./account-scene-policy.cjs').assertAccountScenePolicy(id,read(entry.package),entry.account,read('operations/module-execution-policy.json'));
 if(!entry?.stock_fulfillment_gate)return {registered_hold:false};
 function stop(reason){throw Error('STOCK_FULFILLMENT_HOLD: '+id+' '+stage+': '+reason);}
 let gate,pkg;
 try{gate=read(entry.stock_fulfillment_gate);pkg=read(entry.package);}catch(e){stop('Gate/package evidence unreadable: '+e.message);}
 if(gate.video_id!==id||gate.sha256!==entry.sha256||gate.account!==entry.account||gate.product_id!==pkg.product_id||gate.sku_id!==(pkg.sku_id||pkg.platform_sku_id))stop('Exact job/account/product/SKU binding mismatch');
 if(gate.status!=='released_exact_SKU_fulfillment_verified'||gate.upload_permitted!==true||gate.submit_permitted!==true)stop('Exact SKU fulfillability has not been independently confirmed');
 const ref=gate.release_evidence;let proof;
 try{
  if(!ref?.path||!ref.sha256||hash(ref.path)!==ref.sha256)stop('Missing or changed release evidence');
  proof=read(ref.path);
 }catch(e){stop('Release evidence unavailable: '+e.message);}
 if(proof.product_id!==gate.product_id||proof.sku_id!==gate.sku_id||proof.fulfillable!==true||!Number.isFinite(Date.parse(proof.verified_at))||!Array.isArray(proof.source_receipts)||!proof.source_receipts.length)stop('Release must confirm exact SKU fulfillability and retain source receipts');
 for(const r of proof.source_receipts){try{if(!r.path||!r.sha256||hash(r.path)!==r.sha256)stop('Release source changed');}catch(e){stop('Release source unavailable: '+e.message);}}
 return {registered_hold:true,released:true,release_evidence:path.resolve(ref.path)};
}
module.exports={assertStockFulfillment};
