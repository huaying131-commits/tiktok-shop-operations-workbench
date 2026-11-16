from pathlib import Path
from datetime import datetime, timezone, timedelta
from decimal import Decimal, ROUND_HALF_UP
import subprocess, json, hashlib

root=Path(__file__).resolve().parent.parent
out=root/'outputs/cloud-pricing-2026-10-12'
payload=json.loads((out/'cloud-workbook-payload.json').read_text(encoding='utf-8'))
receipt=json.loads((out/'cloud-create-receipt.json').read_text(encoding='utf-8'))
token=receipt['spreadsheet_token']
node=r'C:\Users\Operator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
cli=r'C:\Users\Operator\AppData\Roaming\npm\node_modules\@larksuite\cli\scripts\run.js'
state_path=out/'cloud-population-checkpoint.json'
state=json.loads(state_path.read_text(encoding='utf-8')) if state_path.exists() else {'completed_batches':{},'styles_complete':False}
calls=0

def save():
    state['updated_at']=datetime.now(timezone(timedelta(hours=8))).isoformat()
    state_path.write_text(json.dumps(state,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')

def call(args,data=None,label=None):
    global calls
    p=subprocess.run([node,cli,*args,'--as','bot'],input=json.dumps(data,ensure_ascii=False) if data is not None else None,text=True,encoding='utf-8',capture_output=True,timeout=45)
    calls+=1
    raw=p.stdout if '{' in p.stdout else p.stderr
    start=raw.find('{')
    if start<0:raise RuntimeError((label or str(args))+': no JSON '+p.stderr[-500:])
    result=json.loads(raw[start:])
    if p.returncode!=0 or result.get('ok') is False or result.get('code',0)!=0:
        raise RuntimeError((label or str(args))+': '+json.dumps(result,ensure_ascii=True))
    if label:
        (out/(label+'.json')).write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    return result

def api(method,path,data,label=None):
    return call(['api',method,path,'--data','-'],data,label)

info=call(['sheets','+info','--spreadsheet-token',token],label='cloud-info-before-data')
sheets=info['data']['sheets']['sheets']
bytitle={s['title']:s for s in sheets}
ids={s['key']:bytitle[s['title']]['sheet_id'] for s in payload['sheets']}
assert len(ids)==5
state['sheet_ids']=ids;save()

if not state.get('structure_finalized'):
    for sh in payload['sheets']:
        actual=bytitle[sh['title']]
        count=actual['grid_properties']['row_count']
        required=len(sh['values'])
        if required>count:
            call(['sheets','+add-dimension','--spreadsheet-token',token,'--sheet-id',ids[sh['key']],'--dimension','ROWS','--length',str(required-count)],label='expand-'+sh['key'])
    req=[]
    for i,sh in enumerate(payload['sheets']):
        req.append({'updateSheet':{'properties':{'sheetId':ids[sh['key']],'index':i,'frozenRowCount':1}}})
    api('POST',f'/open-apis/sheets/v2/spreadsheets/{token}/sheets_batch_update',{'requests':req},'sheet-order-freeze')
    state['structure_finalized']=True;save()

def col(n):
    text=''
    while n:
        n,k=divmod(n-1,26);text=chr(65+k)+text
    return text

for sh in payload['sheets']:
    values=[]
    for row in sh['values']:
        prepared=[]
        for val in row:
            if isinstance(val,str) and val.startswith('='):
                val=val.replace('__OVERVIEW__',"'核价总览'").replace('__COST__',"'成本版本'").replace('COUNTIF(','COUNTIFS(')
                prepared.append({'type':'formula','text':val})
            elif isinstance(val,bool):prepared.append('一致' if val else '不一致')
            else:prepared.append(val)
        values.append(prepared)
    width=max(len(r) for r in values)
    values=[r+['']*(width-len(r)) for r in values]
    for i in range(0,len(values),150):
        chunk=values[i:i+150]
        key=f"{sh['key']}:{i+1}:{i+len(chunk)}"
        digest=hashlib.sha256(json.dumps(chunk,ensure_ascii=False).encode()).hexdigest()
        if state['completed_batches'].get(key)==digest:continue
        api('PUT',f'/open-apis/sheets/v2/spreadsheets/{token}/values',{'valueRange':{'range':f"{ids[sh['key']]}!A{i+1}:{col(width)}{i+len(chunk)}",'values':chunk}})
        state['completed_batches'][key]=digest;save()
    print(json.dumps({'tab_written':sh['title'],'rows':len(values)},ensure_ascii=True),flush=True)

if not state['styles_complete']:
    styles=[]
    for sh in payload['sheets']:
        sid=ids[sh['key']];last=len(sh['values']);width=max(len(r) for r in sh['values']);lastcol=col(width)
        styles.extend([
          {'ranges':[f'{sid}!A1:{lastcol}{last}'],'style':{'vAlign':1}},
          {'ranges':[f'{sid}!A1:{lastcol}1'],'style':{'font':{'bold':True},'backColor':'#243E58','foreColor':'#FFFFFF'}},
        ])
        call(['sheets','+update-dimension','--spreadsheet-token',token,'--sheet-id',sid,'--dimension','COLUMNS','--start-index','1','--end-index',str(width),'--fixed-size','155'],label='width-'+sh['key'])
        call(['sheets','+update-dimension','--spreadsheet-token',token,'--sheet-id',sid,'--dimension','ROWS','--start-index','1','--end-index','1','--fixed-size','42'],label='header-height-'+sh['key'])
    styles.extend([
       {'ranges':[f"{ids['cost']}!E2:F161",f"{ids['cost']}!H2:K161",f"{ids['sku']}!H2:J921"],'style':{'formatter':'#,##0.00'}},
       {'ranges':[f"{ids['overview']}!B6:B7"],'style':{'formatter':'0%','backColor':'#FFF1C7'}},
       {'ranges':[f"{ids['sku']}!C2:G921",f"{ids['cost']}!A2:D161"],'style':{'formatter':'@'}},
    ])
    call(['sheets','+batch-set-style','--spreadsheet-token',token,'--data',json.dumps(styles,ensure_ascii=False)],label='cloud-style-receipt')
    call(['sheets','+update-dimension','--spreadsheet-token',token,'--sheet-id',ids['overview'],'--dimension','COLUMNS','--start-index','2','--end-index','2','--fixed-size','880'],label='width-overview-description')
    for key,column,size in [('sku',3,220),('sku',4,220),('sku',6,220),('cost',4,260),('cost',12,280),('formula',5,650),('formula',6,320),('fee',4,260),('fee',6,380),('fee',7,300),('fee',11,320)]:
        call(['sheets','+update-dimension','--spreadsheet-token',token,'--sheet-id',ids[key],'--dimension','COLUMNS','--start-index',str(column),'--end-index',str(column),'--fixed-size',str(size)])
    state['styles_complete']=True;save()

def read(key,rng,render='UnformattedValue',label=None):
    result=call(['sheets','+read','--spreadsheet-token',token,'--sheet-id',ids[key],'--range',rng,'--value-render-option',render],label=label)
    return result['data']['valueRange']['values']

all_cost=read('cost','A1:O161',label='readback-cost-full')
all_sku=read('sku','A1:L921',label='readback-sku-full')
assert len(all_cost)==161 and len(all_sku)==921
registry=json.loads((root/'pricing/price-registry.json').read_text(encoding='utf-8'))
records=registry['confirmed_records'];matches=registry['shop_matches']
assert all_cost[0]==payload['sheets'][1]['values'][0]
errors=[]
for i,(r,row) in enumerate(zip(records,all_cost[1:]),2):
    assert row[0]==r['price_id'] and row[7]==r['original']
    places=0 if r['market']=='VN' else 2
    for position,discount in [(8,Decimal('0.5')),(9,Decimal('0.51'))]:
        expected=float((Decimal(str(r['original']))*(1-discount)).quantize(Decimal(1).scaleb(-places),rounding=ROUND_HALF_UP))
        assert isinstance(row[position],(float,int)) and abs(row[position]-expected)<1e-8,(i,position,row[position],expected)
    errors.extend((i,v) for v in row if isinstance(v,str) and v.startswith(('#REF!','#VALUE!','#NAME?','#DIV/0!','#N/A','#NUM!')))
for i,(m,row) in enumerate(zip(matches,all_sku[1:]),2):
    assert isinstance(row[2],str) and row[2]==str(m['product_id']),(i,'product_id',row[2])
    assert isinstance(row[3],str) and row[3]==str(m['sku_id']),(i,'sku_id',row[3])
    assert row[6]==m['price_id']
    assert isinstance(row[7],(float,int)) and abs(row[7]-m['target_original'])<1e-8,(i,'original',row[7],m['target_original'])
    errors.extend((i,v) for v in row if isinstance(v,str) and v.startswith(('#REF!','#VALUE!','#NAME?','#DIV/0!','#N/A','#NUM!')))
assert not errors,errors[:5]
formula_cost=read('cost','I2:L4','Formula',label='readback-cost-formulas')
formula_sku=read('sku','H2:I4','Formula',label='readback-sku-formulas')
assert all(isinstance(row[0],str) and row[0].startswith('=') for row in formula_cost)
assert all(isinstance(row[0],str) and row[0].startswith('=') for row in formula_sku)

# Prove a changed input recalculates the existing cloud formulas, then restore it.
call(['sheets','+write','--spreadsheet-token',token,'--sheet-id',ids['overview'],'--range','B7','--values','[[0.52]]'],label='verification-input-change')
try:
    changed=read('cost','J2','UnformattedValue',label='verification-recalculated')
    assert changed[0][0]==float((Decimal(str(records[0]['original']))*Decimal('0.48')).quantize(Decimal('.01'),rounding=ROUND_HALF_UP))
finally:
    call(['sheets','+write','--spreadsheet-token',token,'--sheet-id',ids['overview'],'--range','B7','--values','[[0.51]]'],label='verification-input-restored')
assert read('cost','J2')[0][0]==all_cost[1][9]
meta=call(['sheets','+info','--spreadsheet-token',token],label='cloud-info-final')
ordered=sorted(meta['data']['sheets']['sheets'],key=lambda s:s['index'])
assert [s['title'] for s in ordered]==[s['title'] for s in payload['sheets']]
assert all(s['grid_properties']['frozen_row_count']==1 for s in ordered)
result={'verified_at':datetime.now(timezone(timedelta(hours=8))).isoformat(),'url':receipt['url'],'identity':'bot','app_id':receipt['app_id'],'user_full_access_granted':True,'cost_records_verified':len(records),'sku_bindings_and_text_ids_verified':len(matches),'formula_values_full_readback_verified':True,'formula_text_sample_verified':True,'input_change_recalculation_and_restore_verified':True,'tabs_order_and_frozen_header_verified':True,'styles_api_success':True,'visual_browser_inspection':False,'current_official_fees_verified':False,'calls':calls,'sheet_ids':ids}
(out/'cloud-verification.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
state['status']='populated_and_formula_verified';save()
print(json.dumps(result,ensure_ascii=True),flush=True)
