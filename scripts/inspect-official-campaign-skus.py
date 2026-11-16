"""Read persisted campaign SKU inputs via the authorized Ziniao CLI and DOM.

Opens and cancels edit drawers without changing or submitting any input.
Saves each completed product immediately. Requires observed campaign/product IDs.
"""
import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
p = argparse.ArgumentParser()
p.add_argument("--campaign", required=True)
p.add_argument("--target", required=True)
p.add_argument("--market", choices=["MY", "SG", "VN"], required=True)
p.add_argument("--ids", nargs="+", required=True)
p.add_argument("--output", required=True)
a = p.parse_args()
root = Path(__file__).resolve().parent.parent
cfg = json.loads((root / "config/project-context.json").read_text(encoding="utf-8-sig"))["official_ziniao_cli"]
head = {"SG": "SGSingapore(zigzoom.sg)", "MY": "MYMalaysia(example-shop-my)", "VN": "VNVietnam(example-shop-my)"}[a.market]
base = "/promotion/campaign/detail/" + a.campaign
guard = "const h=document.querySelector('.ub-triggerContent-c31a58')?.innerText.replace(/\\s/g,'');if(location.host!=='seller.tiktokshopglobalselling.com'||!location.pathname.startsWith(BASE)||h!==HEAD)throw Error('Page identity mismatch');".replace("BASE", json.dumps(base)).replace("HEAD", json.dumps(head))

def run(body):
    command = [cfg["binary_path"], "page", "exec", "--store-id", str(cfg["store_id"]), "--target-id", a.target, "--script", "(()=>{" + guard + body + "})()"]
    r = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", timeout=45)
    result = json.loads(r.stdout)
    inner = result.get("data", {}).get("data", {})
    if r.returncode or not result.get("ok") or inner.get("exceptionDetails") or inner.get("targetId") != a.target:
        raise RuntimeError(json.dumps(result, ensure_ascii=False))
    if not isinstance(inner.get("result"), str):
        raise RuntimeError("Synchronous DOM result required")
    return json.loads(inner["result"])

def run_loaded(body):
    for attempt in range(8):
        try:
            return run(body)
        except RuntimeError as error:
            if attempt == 7 or not any(t in str(error) for t in ("No rendered SKU rows", "Drawer missing")):
                raise
            time.sleep(0.6)

output = Path(a.output)
output.parent.mkdir(parents=True, exist_ok=True)
records = {"market": a.market, "campaign_id": a.campaign, "operation": "read_only_edit_drawer_inspection", "products": {}}
for pid in a.ids:
    if not pid.isdigit():
        raise ValueError("Invalid product ID")
    run("if(location.pathname.includes('/edit/'))throw Error('Previous drawer open');const row=[...document.querySelectorAll('tr')].find(e=>e.getClientRects().length&&e.innerText.includes(PID)&&[...e.querySelectorAll('button')].some(b=>b.innerText==='编辑'));const button=row&&[...row.querySelectorAll('button')].find(e=>e.innerText==='编辑');if(!button)throw Error('Product not rendered');button.click();return JSON.stringify({opened:PID});".replace("PID", json.dumps(pid)))
    # The CLI does not await page promises; wait outside the page, then read DOM.
    time.sleep(0.4)
    data = run_loaded("if(!location.pathname.endsWith('/edit/'+PID))throw Error('Wrong product');const d=[...document.querySelectorAll('.theme-arco-drawer')].find(e=>e.getClientRects().length);if(!d)throw Error('Drawer missing');const rows=[...d.querySelectorAll('tr')].filter(e=>e.querySelector('input[data-uid=\"priceinputv2:currencyinput:aadb9\"]')).map(e=>({sku_id:e.querySelector('input[type=checkbox]')?.value,value:e.querySelector('input[data-uid=\"priceinputv2:currencyinput:aadb9\"]').value,cells:[...e.querySelectorAll('td')].map(c=>c.innerText)}));if(!rows.length)throw Error('No rendered SKU rows');return JSON.stringify({href:location.href,header:h,title:d.innerText.slice(0,400),rows});".replace("PID", json.dumps(pid)))
    records["products"][pid] = data
    output.write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8")
    run("if(!location.pathname.endsWith('/edit/'+PID))throw Error('Wrong product');const b=document.querySelector('.theme-arco-drawer [data-uid=\"footer:button:4e0dd\"]');if(!b)throw Error('Cancel missing');b.click();return JSON.stringify({closed:PID});".replace("PID", json.dumps(pid)))
    print(json.dumps({"product": pid, "sku_count": len(data["rows"]), "saved": str(output)}, ensure_ascii=False), flush=True)
