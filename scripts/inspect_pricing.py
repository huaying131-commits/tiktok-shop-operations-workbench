import json
import posixpath
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET
from openpyxl.formula.translate import Translator

source = Path(sys.argv[1])
out = Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
ns = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
with zipfile.ZipFile(source) as z:
    strings = []
    if 'xl/sharedStrings.xml' in z.namelist():
        root = ET.fromstring(z.read('xl/sharedStrings.xml'))
        strings = [''.join(si.itertext()) for si in root]
    rels = ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))
    targets = {e.attrib['Id']: e.attrib['Target'] for e in rels}
    wb = ET.fromstring(z.read('xl/workbook.xml'))
    sheets = []
    for s in wb.find('m:sheets', ns):
        target = targets[s.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']]
        path = target.lstrip('/') if target.startswith('/') else posixpath.normpath('xl/' + target)
        root = ET.fromstring(z.read(path))
        cells = []
        for c in root.findall('.//m:sheetData/m:row/m:c', ns):
            v = c.find('m:v', ns)
            f = c.find('m:f', ns)
            inline = c.find('m:is', ns)
            value = v.text if v is not None else None
            if c.get('t') == 's' and value is not None:
                value = strings[int(value)]
            if inline is not None:
                value = ''.join(inline.itertext())
            if value is not None or f is not None:
                cells.append({'cell': c.attrib['r'], 'type': c.get('t'), 'value': value,
                              'formula': f.text if f is not None else None,
                              'formula_attrs': dict(f.attrib) if f is not None else None})
        bases = {c['formula_attrs']['si']: c for c in cells
                 if c['formula_attrs'] and c['formula_attrs'].get('t') == 'shared' and c['formula']}
        for c in cells:
            attrs = c['formula_attrs'] or {}
            if attrs.get('t') == 'shared' and not c['formula']:
                base = bases[attrs['si']]
                c['formula'] = Translator('=' + base['formula'], origin=base['cell']).translate_formula(c['cell'])[1:]
        dimension = root.find('m:dimension', ns)
        sheets.append({'name': s.attrib['name'], 'path': path,
                       'dimension': dimension.get('ref') if dimension is not None else None,
                       'cells': cells, 'merges': [e.get('ref') for e in root.findall('m:mergeCells/m:mergeCell', ns)]})
    data = {'source': str(source), 'sheets': sheets,
            'defined_names': [{'attributes': e.attrib, 'text': e.text} for e in wb.findall('m:definedNames/m:definedName', ns)],
            'external_links': [n for n in z.namelist() if n.startswith('xl/externalLinks/')],
            'media_count': sum(n.startswith('xl/media/') for n in z.namelist()),
            'media_bytes': sum(i.file_size for i in z.infolist() if i.filename.startswith('xl/media/'))}
    (out / 'pricing-extracted.json').write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'sheets': [{'name': s['name'], 'dimension': s['dimension'], 'cells': len(s['cells']),
                                'formulas': sum(c['formula'] is not None or c['formula_attrs'] is not None for c in s['cells']),
                                'preview': s['cells'][:18]} for s in sheets],
                      'defined_names': data['defined_names'], 'external_links': data['external_links'],
                      'media_count': data['media_count'], 'media_bytes': data['media_bytes']}, ensure_ascii=False))
