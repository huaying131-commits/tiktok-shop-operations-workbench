"""Keep official template packaging, using artifact-tool-authored price cells only.

The platform's A1:ZZ20000 conditional formats cover 14M cells and stall the
preview engine. A separate bounded working copy is used for artifact import and
rendering. The original ZIP metadata/styles/protection/CF are preserved exactly
in the upload file. This helper does not calculate or invent prices.
"""
import argparse,json,re,zipfile,xml.etree.ElementTree as ET,hashlib,copy
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
OUT=ROOT/'outputs/reprice-sg-vn-2026-10-04'
NS={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
p=argparse.ArgumentParser();p.add_argument('mode',choices=['working','final']);args=p.parse_args()
for market in ['SG','VN']:
    original=OUT/f'{market}-sales-before.xlsx'
    items=json.loads((OUT/f'{market.lower()}-skus-before.json').read_text(encoding='utf8'))
    sheet='xl/worksheets/sheet1.xml'
    with zipfile.ZipFile(original) as source:
        xml=source.read(sheet).decode('utf8')
        if args.mode=='working':
            bounded=re.sub(r'(<dimension\s+ref=")[^"]+("[^>]*>)',r'\g<1>A1:AL'+str(items[-1]['excel_row'])+r'\2',xml)
            bounded=bounded.replace('sqref="A1:ZZ20000"','sqref="A1:G'+str(items[-1]['excel_row'])+'"')
            bounded=bounded.replace('HiddenStyle!$A$1:$ZZ$20000','HiddenStyle!$A$1:$G$2')
            bounded=bounded.replace('max="16384"','max="38"')
            destination=OUT/f'{market}-sales-working.xlsx'
            with zipfile.ZipFile(destination,'w',zipfile.ZIP_DEFLATED) as z:
                for entry in source.infolist():z.writestr(copy.copy(entry),bounded.encode('utf8') if entry.filename==sheet else source.read(entry.filename))
            print(json.dumps({'market':market,'working_copy':str(destination),'original_unchanged':True}))
            continue
        with zipfile.ZipFile(OUT/f'{market}-sales-artifact.xlsx') as authored:
            workbook=ET.fromstring(authored.read('xl/workbook.xml'))
            rels=ET.fromstring(authored.read('xl/_rels/workbook.xml.rels'))
            rid=next(s for s in workbook.find('s:sheets',NS) if s.attrib['name']=='Template').attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']
            target=next(r.attrib['Target'] for r in rels if r.attrib['Id']==rid)
            target=target.lstrip('/') if target.startswith('/') else 'xl/'+target
            authoredRoot=ET.fromstring(authored.read(target))
            cells={c.attrib['r']:c for c in authoredRoot.findall('.//s:c',NS)}
            plan=json.loads((OUT/f'{market.lower()}-price-plan.json').read_text(encoding='utf8'))
            modified=[]
            for item in plan:
                if not item.get('change'):continue
                addr='F'+str(item['excel_row']);c=cells[addr]
                assert c.attrib.get('t','n')=='n', (addr,c.attrib)
                val=c.find('s:v',NS).text
                assert abs(float(val)-item['target_price'])<1e-8
                pattern=r'(<c\b[^>]*\br="'+addr+r'"[^>]*>)(.*?)(</c>)'
                found=re.search(pattern,xml);assert found,addr
                assert not re.search(r'<f\b',found.group(2)),addr
                assert re.search(r'<v>[^<]+</v>',found.group(2)),addr
                body=re.sub(r'<v>[^<]+</v>',lambda _: '<v>'+val+'</v>',found.group(2),count=1)
                # Original F cells are shared strings; convert the authorized F cell to
                # numeric rather than treating a price as a shared-string-table index.
                opening=re.sub(r'\s+t="[^"]*"','',found.group(1))
                xml=xml[:found.start()]+opening+body+found.group(3)+xml[found.end():]
                modified.append(addr)
            destination=OUT/f'{market}-sales-upload.xlsx'
            with zipfile.ZipFile(destination,'w',zipfile.ZIP_DEFLATED) as z:
                for entry in source.infolist():z.writestr(copy.copy(entry),xml.encode('utf8') if entry.filename==sheet else source.read(entry.filename))
        with zipfile.ZipFile(destination) as final:
            assert set(source.namelist())==set(final.namelist())
            assert all(source.read(n)==final.read(n) for n in source.namelist() if n!=sheet)
            before=ET.fromstring(source.read(sheet));after=ET.fromstring(final.read(sheet))
            shared=ET.fromstring(final.read('xl/sharedStrings.xml'))
            strings=[''.join(x.itertext()) for x in shared]
            final_cells={c.attrib['r']:c for c in after.findall('.//s:c',NS)}
            for item in plan:
                c=final_cells['F'+str(item['excel_row'])];value=c.find('s:v',NS).text
                if c.attrib.get('t')=='s':value=strings[int(value)]
                assert abs(float(value)-float(item['target_price']))<1e-8, (market,item['excel_row'],value,item['target_price'])
            for doc in [before,after]:
                for cell in doc.findall('.//s:c',NS):
                    if cell.attrib['r'] in modified:
                        cell.find('s:v',NS).text='AUTHORIZED_PRICE_CHANGE'
                        cell.attrib.pop('t',None)
            assert ET.tostring(before)==ET.tostring(after),'Non-price change detected'
        evidence={'market':market,'modified_cells':modified,'modified_count':len(modified),'all_other_zip_parts_identical':True,
                  'only_F_values_changed':True,'F_cell_type_numeric':True,'upload_file':str(destination),'sha256':hashlib.sha256(destination.read_bytes()).hexdigest()}
        (OUT/f'{market}-upload-integrity.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2),encoding='utf8')
        print(json.dumps(evidence,ensure_ascii=False))
