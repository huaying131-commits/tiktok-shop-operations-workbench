import json, pathlib, re, sys
from decimal import Decimal

market=sys.argv[1].upper()
if market not in ('SG','VN'): raise SystemExit('Unsupported market')
root=pathlib.Path(sys.argv[2])
load=lambda name: json.loads((root/name).read_text('utf-8'))
detail=load(f'{market.lower()}-new-campaign-full-detail.json')
manifest=load(f'{market.lower()}-promotion-prepared.json')
plan={x['sku_id']:x for x in load(f'{market.lower()}-price-plan.json')}
expected=set(manifest['sku_ids'])
found={}
errors=[]
for row in detail['rows']:
    if not row['cells'][2]: continue
    key=row['key'].removeprefix('row-')
    if not re.fullmatch(r'\d{38}',key):
        errors.append({'row_key':key,'error':'SKU ID not present in rendered row'})
        continue
    product,sku=key[:19],key[19:]
    if sku in found: errors.append({'sku_id':sku,'error':'Duplicate'})
    c=row['cells']
    raw=c[1].replace('S$','').replace('₫','').replace(',','').strip()
    if market=='VN': raw=raw.replace('.','')
    retail=Decimal(raw)
    found[sku]={'sku_id':sku,'product_id':product,'retail':str(retail),'discount':c[2],'computed_half':str(retail/2)}
    if sku not in expected:
        errors.append({'sku_id':sku,'error':'Unexpected configured SKU'})
        continue
    p=plan[sku]
    if 'target_half' in p:
        expected_half=Decimal(str(p['target_half']))
    elif p.get('status')=='pilot_verified_keep':
        expected_half=Decimal(str(p['target_price']))/2
    else:
        errors.append({'sku_id':sku,'error':'Missing approved half-price source'})
        continue
    if product!=p['product_id'] or c[2]!='50%' or retail!=Decimal(str(p['target_price'])) or retail/2!=expected_half:
        errors.append({'sku_id':sku,'error':'Product, retail, percentage, or computed half mismatch','actual':found[sku]})
missing=sorted(expected-found.keys())
declared_counts=[int(re.search(r'(\d+) 个 SKU',p['text'])[1]) for p in detail['parents']]
expected_parents={plan[s]['product_id'] for s in expected}
actual_parents={p['id'].removeprefix('row-') for p in detail['parents']}
all_match=not errors and not missing and sum(declared_counts)==len(found)==len(expected) and expected_parents==actual_parents
result={'market':market,'campaign_id':detail['campaign_id'],'captured_at':detail['at'],'sku_count':len(found),'expected_count':len(expected),'product_count':len(actual_parents),'declared_sku_count':sum(declared_counts),'missing':missing,'errors':errors,'all_match':all_match,'scope_discount_retail_and_computed_half_verified':all_match,'actual_checkout_price_not_queried':True,'rows':list(found.values())}
sample_file=root/f'{market.lower()}-effective-price-product-sample.json'
if sample_file.exists():
    sample=json.loads(json.loads(sample_file.read_text('utf-8'))['result'])
    sample_expected=sorted(Decimal(str(x['target_half'])) for x in plan.values() if x['product_id']==sample['productId'] and x['status']!='deleted_verified')
    pattern=r'促销价：S\$(\d+\.\d+)' if market=='SG' else r'促销价：([\d.]+)₫'
    raw=re.findall(pattern,sample['skuDetails'])
    sample_actual=sorted(Decimal(x if market=='SG' else x.replace('.','')) for x in raw)
    sample_match=bool(sample_actual) and sample_actual==sample_expected
    result['effective_price_sample']={'product_id':sample['productId'],'sku_count':len(sample_actual),'expected_count':len(sample_expected),'price_values_match':sample_match,'captured_at':sample['at']}
    result['all_match']=all_match=all_match and sample_match
(root/f'{market.lower()}-published-promotion-verification.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),'utf-8')
print(json.dumps({k:v for k,v in result.items() if k!='rows'},ensure_ascii=False))
if not all_match: raise SystemExit('Published promotion mismatch')
