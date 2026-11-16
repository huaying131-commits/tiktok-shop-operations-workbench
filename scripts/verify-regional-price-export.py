"""Independent read-only check of a fresh Seller Center export against approved plans."""
import argparse,json,hashlib
from pathlib import Path
import openpyxl
root=Path(__file__).resolve().parent.parent;out=root/'outputs/reprice-sg-vn-2026-10-04'
p=argparse.ArgumentParser();p.add_argument('market',choices=['SG','VN']);p.add_argument('file');p.add_argument('--suffix',default='first');a=p.parse_args()
plan=json.loads((out/f'{a.market.lower()}-price-plan.json').read_text(encoding='utf8'))
s=openpyxl.load_workbook(a.file,read_only=True,data_only=True)['Template'];s.reset_dimensions()
live={}
for r in s.iter_rows(min_row=6,values_only=True):
    if not r[0]:continue
    assert str(r[3]) not in live
    live[str(r[3])]={'product_id':str(r[0]),'title':r[2],'variant':r[4],'price':float(r[5]),'seller_sku':r[6] or ''}
errors=[]
deleted=[r for r in plan if r['status'] in ['delete_requested','deleted_verified']]
allowed_deleted={'SG':{'9000000000000000030'},'VN':{'9000000000000000031'}}[a.market]
assert {r['sku_id'] for r in deleted}<=allowed_deleted,'Unapproved deletion in plan'
for row in plan:
    actual=live.get(row['sku_id'])
    if row in deleted:
        if actual:errors.append({'sku':row['sku_id'],'error':'user-requested deletion still present'})
        continue
    if not actual:errors.append({'sku':row['sku_id'],'error':'missing'});continue
    for key in ['product_id','title','variant','seller_sku']:
        if actual[key]!=(row.get(key) or ''):errors.append({'sku':row['sku_id'],'key':key,'before':row.get(key),'after':actual[key]})
    if abs(actual['price']-float(row['target_price']))>1e-7:errors.append({'sku':row['sku_id'],'expected':row['target_price'],'actual':actual['price']})
assert len(live)==len(plan)-len(deleted),'Unexpected SKU count change'
result={'market':a.market,'fresh_export':str(Path(a.file).resolve()),'sha256':hashlib.sha256(Path(a.file).read_bytes()).hexdigest(),
        'sku_count':len(live),'product_count':len({v['product_id'] for v in live.values()}),'all_price_targets_match':not errors,'errors':errors,
        'product_ids_sku_ids_titles_variants_seller_sku_preserved':not any(e.get('key') for e in errors),
        'changed_price_count':sum(bool(r.get('change')) for r in plan),'unresolved_kept_at_old_price':sum(r['status']=='needs_input' for r in plan),
        'deleted_sku_ids':[r['sku_id'] for r in deleted],'authorized_deletions_verified':all(r['sku_id'] not in live for r in deleted)}
(out/f'{a.market.lower()}-price-verification-{a.suffix}.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8')
print(json.dumps(result,ensure_ascii=False));assert not errors,'Live export differs from plan'
