import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const out=path.join(root,'outputs/reprice-sg-vn-2026-10-04');
const require=createRequire(path.join(root,'outputs/pricing-engine-2026-10-03/package.json'));
const {SpreadsheetFile,FileBlob}=await import(pathToFileURL(require.resolve('@oai/artifact-tool')).href);
for(const market of ['SG','VN']){
 const plan=JSON.parse(await fs.readFile(path.join(out,market.toLowerCase()+'-price-plan.json'),'utf8'));
 const verification=JSON.parse(await fs.readFile(path.join(out,market.toLowerCase()+'-price-verification-final.json'),'utf8'));
 if(!verification.all_price_targets_match||!verification.authorized_deletions_verified||verification.unresolved_kept_at_old_price)throw Error('No completed final price/deletion verification');
 const eligible=plan.filter(i=>i.status==='mapped'||i.status==='pilot_verified_keep');
 const wb=await SpreadsheetFile.importXlsx(await FileBlob.load(path.join(out,'Product-Discount-SKU-template.xlsx')));
 const s=wb.worksheets.getItem('Sheet1');
 const headers=s.getRange('A1:E1').values;
 if(headers[0][0]!=='商品id（必填）'||headers[0][1]!=='SKU_id（必填）')throw Error('Unexpected template');
 if(market==='SG'){
  const image=await wb.render({sheetName:'Sheet1',range:'A1:E4',scale:1,format:'png'});
  await fs.writeFile(path.join(out,'promotion-template-before.png'),new Uint8Array(await image.arrayBuffer()));
 }
 // Seller Center parses raw percentage points: 0.5 was rejected for every row.
 // Keep numeric 50 and show a literal percent suffix; verify the imported UI before publication.
 s.getRange('A2:E'+(eligible.length+1)).values=eligible.map(i=>[i.product_id,i.sku_id,50,null,null]);
 s.getRange('A2:B'+(eligible.length+1)).setNumberFormat('@');
 s.getRange('C2:C'+(eligible.length+1)).setNumberFormat('0"%"');
 const actual=s.getRange('A2:C'+(eligible.length+1)).values;
 if(actual.some((a,n)=>a[0]!==eligible[n].product_id||a[1]!==eligible[n].sku_id||a[2]!==50))throw Error('Promotion template mismatch');
 const filename=path.join(out,market+'-50pct-final.xlsx');
 await(await SpreadsheetFile.exportXlsx(wb)).save(filename);
 const image=await wb.render({sheetName:'Sheet1',range:'A1:E7',scale:1,format:'png'});
 await fs.writeFile(path.join(out,market+'-promotion-template-after.png'),new Uint8Array(await image.arrayBuffer()));
 const manifest={market,status:'prepared_not_uploaded_not_published',sku_count:eligible.length,
  product_count:new Set(eligible.map(i=>i.product_id)).size,discount_fraction:0.5,upload_discount_points:50,
  scope:'Final user-confirmed mapped SKUs; exclusions and deleted random aircraft variants omitted. All price and deletion prerequisites verified.',
  sha256:createHash('sha256').update(await fs.readFile(filename)).digest('hex'),file:filename,only_fifty_percent:true,
  sku_ids:eligible.map(i=>i.sku_id),omitted:plan.filter(i=>!eligible.includes(i)).map(i=>({sku_id:i.sku_id,product_id:i.product_id,variant:i.variant}))};
 await fs.writeFile(path.join(out,market.toLowerCase()+'-promotion-prepared.json'),JSON.stringify(manifest,null,2));
 console.log(JSON.stringify({market,sku_count:eligible.length,product_count:manifest.product_count,status:manifest.status}));
}
