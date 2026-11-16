from pathlib import Path
from datetime import datetime, timezone, timedelta
import json, hashlib, re

root = Path(__file__).resolve().parent.parent
out = root/'outputs/cloud-pricing-2026-10-12'
out.mkdir(parents=True, exist_ok=True)
registry = json.loads((root/'pricing/price-registry.json').read_text(encoding='utf-8'))
snapshot = json.loads((root/'outputs/reprice-sg-vn-2026-10-04/pricing-extracted.json').read_text(encoding='utf-8'))
source = Path(snapshot['source'])
before = source.stat()
sha = hashlib.sha256(source.read_bytes()).hexdigest()
after = source.stat()
if (before.st_size,before.st_mtime_ns)!=(after.st_size,after.st_mtime_ns):
    raise RuntimeError('Source changed while checking')
source_matches = sha == registry['source_workbook_sha256']
records = registry['confirmed_records']
matches = registry['shop_matches']
assert len(set(r['price_id'] for r in records)) == len(records)
byid = {r['price_id']:r for r in records}
unmatched = [m for m in matches if m.get('price_id') not in byid]
now = datetime.now(timezone(timedelta(hours=8))).isoformat()

def number(c):
    if c.get('value') is None:
        return ''
    if c.get('type') in ('s','str','inlineStr','e'):
        return c['value']
    try:
        return float(c['value'])
    except (ValueError,TypeError):
        return c['value']

overview = [
 ['运营核价台账','2026-10-12迁移基线'],
 ['状态','近期官方费率和物流计费尚未复核；本表现价依据历史核价记录'],
 ['成本版本数',len(records)],['店铺SKU绑定数',len(matches)],['缺少核价绑定数',len(unmatched)],
 ['跨境1减价',registry['discount_points']['跨境1']/100],
 ['跨境10减价',registry['discount_points']['跨境10']/100],
 ['用途','跨电脑与团队共用：先验证权限和公式，才能作为共同入口'],
 ['价格更新','备份→核官方适用规则→对照账单→新版本复算→SKU差异与回读'],
 ['月度复核','每月1日北京时间10:00；首次复核10月12日09:00后'],
 ['夜间规则','23:00至次日09:00停止巡查与自动执行'],
 ['保本口径','原表8%档是旧情境，不等于实际当期不亏；以实际费率和费用重新核算'],
 ['固定费用','内容制作直接费用当前0；Codex USD200/月按实扣及分摊记经营固定成本'],
 ['来源哈希',sha],['当前源文件与核价版本一致',source_matches],
 ['协作','店铺及SKU ID存文本；必须拥有文档访问权与有效CLI登录'],
 ['未知','缺失成本/费率不填0，不计算貌似可用的新利润价'],
 ['Skill迭代','实测保存证据、成本、失败与恢复，验证后再写回通用Skill']
]
cost = [['price_id','国家','币种','商品/成本版本','采购成本CNY','货代摊销CNY','毛重g','共同原价','跨境1折后价','跨境10折后价','原表达人8%档','51%折后与旧档比较','源表/行','确认日期','费率核验状态']]
for i,r in enumerate(records,2):
    # Cross-sheet references are completed with actual sheet IDs only after cloud creation.
    cost.append([r['price_id'],r['market'],r['currency'],r['name'],r['cost_cny'],r['handling_cny'],r['gross_grams'],r['original'],
                 f'=ROUND(H{i}*(1-__OVERVIEW__!$B$6),IF(B{i}="VN",0,2))',
                 f'=ROUND(H{i}*(1-__OVERVIEW__!$B$7),IF(B{i}="VN",0,2))',r['minimum_8pct'],
                 f'=IF(J{i}>=K{i},"达到原表8%档；实际待核","低于原表8%档")',
                 f"{r.get('source_sheet','')} / {r.get('source_row','')}",r.get('confirmed_date',''),'原表参数；近期官方待核'])
sku = [['国家','店铺','product_id','sku_id','seller_sku','规格','price_id','历史核准原价','折后价','后台回读原价','后台回读日期','绑定/备注']]
end = len(cost)
for i,m in enumerate(matches,2):
    sku.append([m['market'],m['shop'],str(m['product_id']),str(m['sku_id']),m.get('seller_sku',''),m.get('variant',''),m.get('price_id',''),
                f'=IF(COUNTIF(__COST__!$A$2:$A${end},G{i})=1,VLOOKUP(G{i},__COST__!$A$2:$H${end},8,FALSE),"缺失或重复核价ID")',
                f'=IF(ISNUMBER(H{i}),ROUND(H{i}*(1-IF(B{i}="跨境1",__OVERVIEW__!$B$6,__OVERVIEW__!$B$7)),IF(A{i}="VN",0,2)),"待核价")',
                m.get('observed_original',''),m.get('observed_date',''),m.get('note','')])

fee = [['国家/范围','原表工作表','参数单元格','原表标签','原表值','原表公式（文本）','计费基数','近期官方值','官方来源','生效日期','核验状态']]
formulas = [['国家','工作表','单元格','显示/缓存值','原公式（文本）','说明']]
for market,name in [('MY','马来（跨境）老店+新店'),('SG','新加坡（跨境）'),('VN','越南（跨境）')]:
    sh = next(s for s in snapshot['sheets'] if s['name']==name)
    cells = {c['cell']:c for c in sh['cells']}
    for c in sh['cells']:
        row = int(re.search(r'\d+$',c['cell'])[0])
        if row == 2:
            col = re.sub(r'\d+','',c['cell'])
            fee.append([market,name,c['cell'],str(cells.get(col+'1',{}).get('value') or ''),number(c),"'="+c['formula'] if c.get('formula') else '', '待解释原公式并核官方规则','','','','原表历史参数；未查近期'])
        if row<=5 and (c.get('formula') or row<=2):
            formulas.append([market,name,c['cell'],number(c),"'="+c['formula'] if c.get('formula') else '', '缓存/原公式提取；不是实时官方费率'])
logistics = next(s for s in snapshot['sheets'] if '物流价卡' in s['name'])
logcols = {c['cell']:c for c in logistics['cells']}
for c in logistics['cells']:
    if re.match(r'^D\d+$',c['cell']) and c.get('value') is not None:
        row = re.search(r'\d+',c['cell'])[0]
        partner = logcols.get('E'+row)
        if partner:
            fee.append(['MY物流历史价卡',logistics['name'],'D'+row+':E'+row,str(c['value'])+'g',number(partner),'','毛重/体积重/路线适用性待官方核','','','','原表价卡；不能当当前费用'])

sheets = [{'key':'overview','title':'核价总览','values':overview},{'key':'cost','title':'成本版本','values':cost},{'key':'sku','title':'店铺SKU','values':sku},{'key':'fee','title':'费率与物流','values':fee},{'key':'formula','title':'原表公式','values':formulas}]
payload = {'title':'大磊TikTok运营核价台账','prepared_at':now,'source_sha256':sha,'source_matches_registry':source_matches,'sheets':sheets,'current_fees_verified':False,'publish_status':'prepared_wait_user_auth_and_cloud_validation'}
(out/'cloud-workbook-payload.json').write_text(json.dumps(payload,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
summary = {'prepared_at':now,'cost_records':len(records),'shop_matches':len(matches),'unmatched_matches':len(unmatched),'source_matches_registry':source_matches,'source_sha256':sha,'rows_by_tab':{s['title']:len(s['values']) for s in sheets},'actual_fees_verified':False,'cloud_created':False}
(out/'preparation-summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps(summary,ensure_ascii=True))
