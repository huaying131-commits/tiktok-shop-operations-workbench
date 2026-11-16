"""Bootstrap the operator's reusable ledger from this dated run's evidence.

No browser mutations and no writes to the user's original workbook. Exact shop
SKU bindings remain separate from country/cost records. Latest explicit user
cost overrides replace earlier inferred family costs for their exact scope.
"""
import json,hashlib,datetime
from pathlib import Path
from decimal import Decimal,ROUND_CEILING
import openpyxl

root=Path(__file__).resolve().parents[1]
run=root/'outputs/store10-pricing-campaigns-2026-10-08/correction-51pct'
comp=run/'completion-from-visible-MY'
confirmed=comp/'bing-cost-confirmed-2cny'
old=root/'outputs/reprice-sg-vn-2026-10-04'
floors={m:json.loads((root/f'outputs/official-campaigns-2026-10-07/{m.lower()}-price-floors.json').read_text(encoding='utf8')) for m in ['MY','SG','VN']}
source_hash=floors['MY']['source_sha256']
source=Path('C:/Users/Operator/Workspace/我的产品/codex自主运营tiktok店铺/【东南亚】玩具类目成本测算表 .xlsx')
assert hashlib.sha256(source.read_bytes()).hexdigest()==source_hash
visible={m:{e['source_row']:e for e in floors[m]['visible_rows']} for m in floors}
records={};matches=[];omitted=[]
def read_json(path):return json.loads(path.read_text(encoding='utf8'))
def workbook_prices(path):
 b=openpyxl.load_workbook(path,read_only=True,data_only=True)
 s=b['Template'];s.reset_dimensions()
 return {str(r[3].value):dict(product_id=str(r[0].value),price=float(r[5].value)) for r in s.iter_rows(min_row=6) if len(r)>6 and r[0].value}
def rounded_half(raw,market):
 scale=Decimal(1) if market=='VN' else Decimal('0.01')
 return float(Decimal(str(raw)).quantize(scale,rounding=ROUND_CEILING)*2)

def add(shop,market,plan,observed,observed_date):
 fby={e['sku_id']:e for e in floors[market]['sku_floors']}
 for item in plan:
  if item['status'] not in ['mapped','pilot_verified_keep']:continue
  if item['sku_id'] not in observed:
   omitted.append(dict(shop=shop,market=market,sku_id=item['sku_id'],reason='not in final existing export'));continue
  e=dict(item)
  if market in ['SG','VN'] and item['sku_id'] in fby:
   for k,v in fby[item['sku_id']].items():
    if k not in e or k in ['raw_affiliate_8pct_floor','minimum_price']:e[k]=v
  pilot=item['status']=='pilot_verified_keep'
  if pilot:
   e.update(floors[market]['pilot'])
   e.update(source_market='MY',source_row='M3080',source_sheet='已确认商品资料',source_name='M3080迷你盆栽155片',input_cost_cny=8.84,input_handling_cny=1.5,input_gross_grams=200)
  sm=e.get('source_market',market)
  if any(e.get(k) is None for k in ['input_cost_cny','input_handling_cny','input_gross_grams']):
   base=visible[sm].get(e.get('source_row'))
   assert base is not None,('Missing confirmed input',shop,market,e['sku_id'])
   for k in ['input_cost_cny','input_handling_cny','input_gross_grams']:
    if e.get(k) is None:e[k]=base[k]
  assert e.get('raw_half') is not None and e.get('raw_affiliate_8pct_floor') is not None
  inputs=[float(e[k]) for k in ['input_cost_cny','input_handling_cny','input_gross_grams']]
  target=float(e['target_price'])
  assert abs(target-rounded_half(e['raw_half'],market))<1e-6,(market,e['sku_id'],'noncanonical original')
  key=json.dumps([market,sm,e.get('source_row'),*inputs],ensure_ascii=False,separators=(',',':'))
  price_id=market+'-'+hashlib.sha256(key.encode()).hexdigest()[:10].upper()
  override=bool(e.get('user_confirmed_input_override'))
  name='Bing系列6款（摊销2元）' if override and e.get('source_row')==7 else e.get('source_name') or e['variant']
  rec=dict(price_id=price_id,market=market,currency={'MY':'MYR','SG':'SGD','VN':'VND'}[market],name=name,
   source_market=sm,source_row=e.get('source_row'),source_sheet=e.get('source_sheet') or floors[sm]['source_sheet'],
   cost_cny=inputs[0],handling_cny=inputs[1],gross_grams=inputs[2],original=target,
   raw_original=e.get('raw_original'),raw_half=e['raw_half'],raw_floor_8pct=e['raw_affiliate_8pct_floor'],
   minimum_8pct=float(Decimal(str(e['raw_affiliate_8pct_floor'])).quantize(Decimal('1') if market=='VN' else Decimal('.01'),rounding=ROUND_CEILING)),
   user_confirmed_override=override,cost_basis='用户逐项确认' if override else '原表可见记录及已审查规格匹配',
   source_workbook_sha256=source_hash,variants=[],shop_sku_count=0,confirmed_date='2026-10-08' if override else '2026-10-07')
  if key in records:
   prev=records[key]
   assert prev['original']==target and abs(prev['raw_floor_8pct']-rec['raw_floor_8pct'])<1e-6,'Conflicting records for same country/input version'
   if override:prev['user_confirmed_override']=True;prev['cost_basis']='用户逐项确认';prev['name']=name;prev['confirmed_date']='2026-10-08'
  else:records[key]=rec
  rec=records[key]
  if e['variant'] not in rec['variants']:rec['variants'].append(e['variant'])
  rec['shop_sku_count']+=1
  actual=observed[e['sku_id']]
  assert actual['product_id']==e['product_id']
  note='旧F18官方秒杀RM23.55获准清仓保留' if shop=='跨境10' and market=='MY' and e['sku_id']=='9000000000000000029' else ''
  matches.append(dict(shop=shop,market=market,product_id=e['product_id'],sku_id=e['sku_id'],variant=e['variant'],seller_sku=e.get('seller_sku',''),price_id=price_id,target_original=target,observed_original=float(actual['price']),observed_date=observed_date,note=note))

for shop,market,path,actual,date in [
 ('跨境10','MY',confirmed/'my-price-plan.json',confirmed/'my-skus-after.json','2026-10-08'),
 ('跨境10','VN',comp/'vn-price-plan.json',comp/'vn-skus-after.json','2026-10-08'),
 ('跨境1','MY',confirmed/'store1-MY/my-price-plan.json',confirmed/'store1-MY/my-skus-after.json','2026-10-08')]:
 a=read_json(actual)['items'];add(shop,market,read_json(path),{e['sku_id']:dict(product_id=e['product_id'],price=float(e['price'])) for e in a},date)
for market in ['SG','VN']:
 actual=workbook_prices(old/f'{market}-sales-after-final.xlsx')
 date='2026-10-04'
 if market=='VN':
  a=read_json(run/'store1-VN/vn-skus-before.json')['items'];actual={e['sku_id']:dict(product_id=e['product_id'],price=float(e['price'])) for e in a};date='2026-10-08'
 add('跨境1',market,read_json(old/f'{market.lower()}-price-plan.json'),actual,date)
assert len(matches)==920 and len({(e['shop'],e['market'],e['sku_id']) for e in matches})==920
for e in matches:
 if e['observed_date']=='2026-10-08':assert abs(e['observed_original']-e['target_original'])<1e-6,(e,'live original mismatch')
registry=dict(schema_version=1,updated_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
 source_workbook='【东南亚】玩具类目成本测算表 .xlsx',source_workbook_sha256=source_hash,source_workbook_changed=False,
 current_platform_fees_verified=False,discount_points={'跨境1':50,'跨境10':51},
 confirmed_records=sorted(records.values(),key=lambda e:({'MY':0,'SG':1,'VN':2}[e['market']],0 if e['user_confirmed_override'] else 1,str(e['source_row']))),
 shop_matches=sorted(matches,key=lambda e:(e['shop'],e['market'],e['product_id'],e['sku_id'])),
 exclusions='未核准成本、用户排除项及已删除规格未放入已确认定价；跨境10SG暂停商品尚未核价或写入',omitted=omitted,
 clearance_exceptions=[dict(shop='跨境10',market='MY',sku_id='9000000000000000029',campaign_id='9000000000000000104',price=23.55,user_confirmed=True)])
out=root/'pricing';out.mkdir(exist_ok=True)
path=out/'price-registry.json'
if path.exists():
 existing=read_json(path)
 # Historical run plans must not overwrite confirmations maintained later.
 for field in ['confirmed_records','shop_matches','discount_points','clearance_exceptions']:
  if existing.get(field)!=registry.get(field):
   raise RuntimeError('Existing price registry has newer or different maintained data; historical bootstrap refused to overwrite '+field)
 backup=out/('price-registry-before-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S')+'.json');backup.write_bytes(path.read_bytes())
path.write_text(json.dumps(registry,ensure_ascii=False,indent=2),encoding='utf8')
print(json.dumps({'records':len(records),'shop_skus':len(matches),'country_record_counts':{m:sum(e['market']==m for e in records.values()) for m in ['MY','SG','VN']},'source_workbook_unchanged':True},ensure_ascii=False))
