"""Build an explicit reviewable SKU mapping. No website writes or XLSX writes."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'outputs/reprice-sg-vn-2026-10-04'
SHEETS = {'MY': '马来（跨境）老店+新店', 'SG': '新加坡（跨境）', 'VN': '越南（跨境）'}
catalog = json.loads((OUT / 'pricing-visible-catalog.json').read_text(encoding='utf8'))
maps = {'SG': {}, 'VN': {}}

def setrows(market, rows, source, row, reason):
    for r in rows:
        if r in maps[market]:
            raise ValueError(f'Duplicate mapping {market} {r}')
        visible = catalog['sheets'][SHEETS[source]]['visible_product_rows']
        original = next(x for x in visible if x['row'] == row)
        assert not original['hidden']
        maps[market][r] = {'source_market': source, 'source_sheet': SHEETS[source], 'source_row': row,
                           'input_cost_cny': float(original['D']), 'input_handling_cny': float(original['F']),
                           'input_gross_grams': float(original['G']), 'source_name': original.get('C'),
                           'reason': reason, 'method': 'visible_country_row' if source == market else 'visible_MY_inputs_country_formula'}

def rr(m, rows, row, reason): setrows(m, rows, m, row, reason)
def my(m, rows, row, reason): setrows(m, rows, 'MY', row, reason)

# Match exact model/size within each parent. Every export row is reconciled below.
rr('SG', list(range(6,12))+[136,137,138],74,'15cm Godzilla; seller SKU confirms mistranslated red King Kong')
rr('SG', list(range(12,16))+list(range(139,143)),75,'23cm Godzilla')
rr('SG', [16,17,143],76,'29cm King Kong')
rr('SG', [18,19,144,145],78,'Mecha King Kong')
rr('SG', [20,146],77,'Breathing Godzilla')
rr('SG', range(21,30),79,'Bing rabbit series')
rr('SG', range(68,77),80,'Bing rabbit series second listing')
rr('SG', range(30,34),70,'Turtle coaster single')
rr('SG', [34,35],73,'Stitch coaster')

# Clear aircraft variants. SU27/YF23 duplicate visible cost rows remain unresolved.
sg_air = {36:41,37:40,38:40,39:62,40:44,41:42,42:44,43:44,44:45,45:46,
          46:47,47:48,48:43,49:50,50:51,51:52,52:53,53:55,54:56,55:37,56:59,
          57:66,58:65,59:67,60:68,61:38,62:39,63:69,64:69,65:69,66:60,67:63,
          107:44,108:44,109:40,110:40,111:44,112:37,113:56,114:38,115:39,
          116:50,117:51,118:47,119:52,120:53,121:7,
          211:40,212:44,213:44,214:44,215:40,216:47,217:37,218:56,
          219:40,220:40,221:44,222:44,223:44,224:47,225:37}
for er,sr in sg_air.items(): rr('SG',[er],sr,'Aircraft exact model; TU-150 seller SKU aliases visible TU-160')
rr('SG',[77,78,161,162],97,'Zootopia Judy/Nick plush')
rr('SG',[79,80],99,'Zootopia keychain')
rr('SG',[81],100,'Running fox small')
rr('SG',[82],101,'Running fox large')
rr('SG',list(range(84,90))+list(range(92,104))+[105],83,'Fuggler regular plush')
my('SG',[90,104,135,180],63,'Lab sticker distinct from plush; MY visible sticker row')
rr('SG',list(range(123,135))+list(range(168,180)),87,'Fuggler keychain, excludes stickers')
rr('SG',list(range(147,150))+list(range(154,157)),9,'Toothless luminous upgrade')
rr('SG',list(range(150,154))+list(range(157,161)),8,'Toothless ordinary; seller SKU confirms')
my('SG',[165],115,'ADI large')
my('SG',[166,167],116,'ADI medium/small explicitly grouped in MY')
rr('SG',[181,182,204,205],96,'Maze cube visible row96, excludes hidden trial row122')
my('SG',range(183,194),89,'Stranger Things POP')
my('SG',range(194,204),86,'Volleyball 23cm plush')
rr('SG',[206],151,'Bracelet A smart')
rr('SG',[207],152,'Bracelet B smart')
rr('SG',[208],153,'Bracelet C smart')
rr('SG',[209,210],154,'Bracelet D/E nonfunctional shared row')

vn_air={6:79,7:77,8:82,9:83,10:83,11:82,12:59,13:64,15:61,16:53,17:54,18:62,19:63,
        21:60,22:65,23:66,24:57,25:58,26:55,27:56,31:6,
        169:82,170:82,171:83,172:83,173:59,174:53,175:54,176:55,177:56,
        178:62,179:63,180:64,181:65,182:66,183:6,
        227:82,228:82,229:59,230:83,232:53,233:54,
        234:83,235:82,236:82,237:59,238:83,239:64,240:53,241:54,
        242:83,243:83,244:82,245:82,246:59,247:64,248:53}
for er,sr in vn_air.items(): rr('VN',[er],sr,'Aircraft model; F18 standard differs from new F18/Rafale')
# Additional VN aircraft missing a visible local row have an unambiguous MY input row.
myrows = {r['C'].strip():r['row'] for r in catalog['sheets'][SHEETS['MY']]['visible_product_rows'] if r.get('C')}
for label in ['F14','J-35','坦克']:
    assert label in myrows, label
my('VN',[14],myrows['F14'],'F14 standard versus F14 black-cat')
my('VN',[20],myrows['J-35'],'J35 fighter')
my('VN',[28,29,30],myrows['坦克'],'Tank variants')
my('VN',list(range(32,36))+list(range(40,44)),8,'Turtle coaster single')
my('VN',[36,37,44,45],12,'Stitch coaster')
rr('VN',range(46,52),84,'15cm Godzilla')
rr('VN',range(52,56),85,'23cm Godzilla')
rr('VN',[56,57],86,'29cm King Kong')
rr('VN',[58,59],88,'Mecha King Kong')
rr('VN',[60,62],87,'Breathing Godzilla')
rr('VN',[61,70,89,93,119,127,135,153,167,168,187,211,226],6,'Warranty/do not buy card exact visible country row')
my('VN',range(63,70),7,'Bing rabbit original series, seller SKU 158966604924')
my('VN',list(range(71,84))+[85]+list(range(95,103)),58,'Fuggler regular plush')
my('VN',[84,103,152,166],63,'Lab sticker')
my('VN',[87,90],64,'Running fox small')
my('VN',[88,91],65,'Running fox large')
my('VN',[92],66,'Fox pendant')
my('VN',range(105,111),83,'Naruto vinyl plush series')
my('VN',[111,112,136,137],67,'Zootopia Judy/Nick plush')
my('VN',[115,116,117,118],68,'Zootopia keychain same parent')
my('VN',list(range(120,123))+list(range(128,131)),78,'Toothless luminous upgrade')
my('VN',list(range(123,127))+list(range(131,135)),77,'Toothless ordinary seller SKU confirms')
my('VN',list(range(140,152))+list(range(154,166)),62,'Fuggler keychain; regular lab monster keychain source')
my('VN',[185,186,209,210],80,'Maze cube')
my('VN',range(194,198),81,'Transformer individual cars, excludes unnamed 800g row')
my('VN',range(198,209),89,'Stranger Things POP')
rr('VN',[212,213],144,'Bracelet D/E nonfunctional shared row')
my('VN',list(range(214,217))+list(range(249,252)),85,'Needoh 3cm')
my('VN',list(range(217,226))+list(range(252,260)),84,'Needoh standard 5/5.5cm')
my('VN',range(260,266),182,'Coconut squishy')

# User-confirmed final mappings, 2026-10-04. Stitch holder uses coaster weight.
my('SG',[83],58,'User confirmed Fuggler clown maps to MY laboratory main listing')
my('SG',[91,106],62,'User confirmed lion-head charms map to MY laboratory monster keychain')
my('VN',[38,39],12,'User confirmed Stitch holder cost and same 100g weight as MY Stitch coaster')
my('VN',[94],58,'User confirmed Fuggler clown maps to MY laboratory main listing')
my('VN',[86,104],62,'User confirmed lion-head pendants map to MY laboratory monster keychain')
rr('VN',[231],83,'User confirmed TU-60 is TU-160; use visible country TU150/Y20 pricing row')

for market in ['SG','VN']:
    items=json.loads((OUT/f'{market.lower()}-skus-before.json').read_text(encoding='utf8'))
    excluded_rows={'SG':{163,164},'VN':{113,114,138,139,*range(188,194),*range(266,270)}}[market]
    for item in items:
        mapped=maps[market].get(item['excel_row'])
        if mapped: item.update(mapped,status='mapped')
        elif item['seller_sku']=='MY-M3080-PINK-155': item.update(status='pilot_verified_keep',reason='M3080 prior formula and live price already verified')
        elif item['excel_row'] in excluded_rows: item.update(status='excluded_by_user',reason='User excluded from this repricing/promotion run; no delisting/deletion authorized or performed')
        elif item['excel_row'] in ({122} if market=='SG' else {184}): item.update(status='delete_requested',reason='User explicitly requested deletion of the random aircraft variant in SG/VN; verify removal before completion')
        else: item.update(status='needs_input',reason='Cost/variant mapping unresolved; no price change and no new promotion yet')
    (OUT/f'{market.lower()}-mapping.json').write_text(json.dumps(items,ensure_ascii=False,indent=2),encoding='utf8')
    pending=[{'row':i['excel_row'],'product_id':i['product_id'],'variant':i['variant'],'price':i['price']} for i in items if i['status']=='needs_input']
    print(json.dumps({'market':market,'mapped':sum(i['status']=='mapped' for i in items),'pending':pending},ensure_ascii=False))
