"""Read workbook row/column visibility before matching live product prices."""
import hashlib
import json
import posixpath
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

sys.stdout.reconfigure(encoding="utf-8")
root = Path(__file__).resolve().parent.parent
run = root / "outputs/reprice-sg-vn-2026-10-04"
data = json.loads((run / "pricing-extracted.json").read_text(encoding="utf-8"))
source = Path(data["source"])
ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
catalog = {"source": str(source), "sha256": hashlib.sha256(source.read_bytes()).hexdigest(), "sheets": {}}
with zipfile.ZipFile(source) as z:
    for sheet in data["sheets"]:
        if sheet["name"] not in ["新加坡（跨境）", "越南（跨境）", "马来（跨境）老店+新店"]:
            continue
        xml = ET.fromstring(z.read(sheet["path"]))
        hidden = [int(r.get("r")) for r in xml.findall("m:sheetData/m:row", ns) if r.get("hidden") in ("1", "true")]
        cells = {c["cell"]: c for c in sheet["cells"]}
        rows = []
        for r in sorted(set(int(re.sub("[A-Z]", "", c)) for c in cells)):
            if r < 5 or r in hidden or not cells.get(f"D{r}", {}).get("value"):
                continue
            row = {"row": r, "hidden": False}
            for col in ["A", "B", "C", "D", "F", "G", "M", "N", "Q", "R", "S", "T"]:
                row[col] = cells.get(f"{col}{r}", {}).get("value")
            rows.append(row)
        info = {"hidden_rows": hidden, "hidden_columns": [dict(c.attrib) for c in xml.findall("m:cols/m:col", ns) if c.get("hidden") in ("1", "true")], "visible_product_rows": rows}
        catalog["sheets"][sheet["name"]] = info
(run / "pricing-visible-catalog.json").write_text(json.dumps(catalog, ensure_ascii=False, indent=2), encoding="utf-8")
for name, info in catalog["sheets"].items():
    if name.startswith("马来"):
        continue
    print(name, "hidden:", len(info["hidden_rows"]), "visible products:", len(info["visible_product_rows"]))
    for row in info["visible_product_rows"]:
        print(" | ".join(str(row.get(k) or "") for k in ["row", "A", "C", "D", "F", "G", "N" if name.startswith("新加坡") else "M", "R" if name.startswith("新加坡") else "Q"]))
