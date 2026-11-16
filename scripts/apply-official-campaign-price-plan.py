"""Apply a reviewed SG campaign price plan through observed DOM controls.

Only lowers existing prices to validated 50% values. Never enrolls, withdraws,
raises prices, accepts terms, retries an uncertain save, or edits inventory.
The caller must have verified that this exact activity is free/platform funded.
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
p.add_argument("--plan", required=True)
p.add_argument("--output", required=True)
a = p.parse_args()
root = Path(__file__).resolve().parent.parent
cfg = json.loads((root / "config/project-context.json").read_text(encoding="utf-8-sig"))["official_ziniao_cli"]
plan = json.loads(Path(a.plan).read_text(encoding="utf-8-sig"))
groups = {}
for item in plan:
    if not item["pass"] or item["target"] < item["raw_half"] or item["target"] > item["old"] or abs(item["target"] * 2 - item["retail"]) > 0.00001:
        raise ValueError("Invalid reviewed price plan")
    groups.setdefault(item["product_id"], []).append(item)
base = "/promotion/campaign/detail/" + a.campaign
guard = "const h=document.querySelector('.ub-triggerContent-c31a58')?.innerText.replace(/\\s/g,'');if(location.host!=='seller.tiktokshopglobalselling.com'||!location.pathname.startsWith(BASE)||h!=='SGSingapore(zigzoom.sg)')throw Error('Page identity mismatch');".replace("BASE", json.dumps(base))
record = {"campaign_id": a.campaign, "market": "SG", "products": {}}
output = Path(a.output)
output.parent.mkdir(parents=True, exist_ok=True)

def save():
    output.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")

def run(body):
    r = subprocess.run([cfg["binary_path"], "page", "exec", "--store-id", str(cfg["store_id"]), "--target-id", a.target, "--script", "(()=>{" + guard + body + "})()"], capture_output=True, text=True, encoding="utf-8", timeout=45)
    data = json.loads(r.stdout)
    inner = data.get("data", {}).get("data", {})
    if r.returncode or not data.get("ok") or inner.get("exceptionDetails") or inner.get("targetId") != a.target:
        raise RuntimeError(json.dumps(data, ensure_ascii=False))
    return json.loads(inner["result"])

def open_drawer(pid):
    run("if(location.pathname.includes('/edit/'))throw Error('Another edit open');const r=[...document.querySelectorAll('tr')].find(e=>e.innerText.includes(PID));const b=r&&[...r.querySelectorAll('button')].find(e=>e.innerText==='编辑');if(!b)throw Error('Missing product');b.click();return JSON.stringify({opened:PID});".replace("PID", json.dumps(pid)))
    for _ in range(10):
        time.sleep(0.5)
        result = run("if(!location.pathname.endsWith('/edit/'+PID))throw Error('Wrong product');const d=document.querySelector('.theme-arco-drawer');return JSON.stringify({ready:!!d?.querySelector('input[data-uid=\"priceinputv2:currencyinput:aadb9\"]')});".replace("PID", json.dumps(pid)))
        if result["ready"]:
            return
    raise RuntimeError("Drawer did not load")

try:
    for pid, entries in groups.items():
        record["products"][pid] = {"status": "inspecting", "plan": entries}
        save()
        open_drawer(pid)
        prefix = "if(!location.pathname.endsWith('/edit/'+PID))throw Error('Wrong product');const d=document.querySelector('.theme-arco-drawer');const plan=PLAN;".replace("PID", json.dumps(pid)).replace("PLAN", json.dumps(entries))
        inspect = "const fields=plan.map(f=>{const i=d.querySelector('#skus_'+f.sku_id+'_sku_campaign_info_campaign_price_amount_input');if(!i)throw Error('Missing SKU '+f.sku_id);const c=[...i.closest('tr').querySelectorAll('td')].map(e=>e.innerText);if(Number(c[2].replace('S$',''))!==f.retail||f.target>Number(c[3].split('-S$')[1])||f.target<f.raw_half)throw Error('Retail/cap/floor mismatch');if(Number(i.value)!==f.old&&Number(i.value)!==f.target)throw Error('Stale price '+f.sku_id);return {i,f};});"
        result = run(prefix + inspect + "const changes=fields.filter(({i,f})=>Number(i.value)!==f.target);for(const {i,f}of changes){i.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,f.target.toFixed(2));i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new Event('change',{bubbles:true}));}return JSON.stringify({changed:changes.length});")
        if result["changed"]:
            record["products"][pid]["status"] = "save_dispatch_pending"
            save()
            run(prefix + "document.activeElement.blur();for(const f of plan){const i=d.querySelector('#skus_'+f.sku_id+'_sku_campaign_info_campaign_price_amount_input');if(Number(i?.value)!==f.target)throw Error('Input mismatch');}const b=d.querySelector('[data-uid=\"footer:button:73277\"]');if(!b||b.disabled)throw Error('Save disabled');b.click();return JSON.stringify({dispatched:true});")
            for _ in range(12):
                time.sleep(0.5)
                state = run("return JSON.stringify({open:location.pathname.includes('/edit/'),dialogs:[...document.querySelectorAll('[role=dialog]')].filter(e=>e.getClientRects().length).map(e=>e.innerText),drawer:document.querySelector('.theme-arco-drawer')?.innerText});")
                if not state["open"]:
                    break
                if state["dialogs"] or "活动价格不能提高" in (state.get("drawer") or ""):
                    raise RuntimeError("Save requires review: " + json.dumps(state, ensure_ascii=False))
            if state["open"]:
                raise RuntimeError("Save status uncertain; no retry")
            open_drawer(pid)
        final = run(prefix + "const rows=plan.map(f=>{const i=d.querySelector('#skus_'+f.sku_id+'_sku_campaign_info_campaign_price_amount_input');if(Number(i?.value)!==f.target)throw Error('Persisted value mismatch '+f.sku_id);return {sku_id:f.sku_id,actual:Number(i.value),expected:f.target};});return JSON.stringify({rows});")
        record["products"][pid].update(status="persisted_verified", changed=result["changed"], verification=final)
        save()
        run(prefix + "d.querySelector('[data-uid=\"footer:button:4e0dd\"]').click();return JSON.stringify({closed:true});")
        print(json.dumps({"product": pid, "verified_skus": len(entries), "changed_this_run": result["changed"]}), flush=True)
except Exception as error:
    record["error"] = str(error)
    save()
    raise
