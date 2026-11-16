"""Run an observed DOM operation in the existing authorized Ziniao environment.

Each invocation is one official CLI call. Guard the visible market/shop before
execution and verify the returned tab afterwards; never blindly retry writes.
"""
import argparse
import datetime
import json
import subprocess
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
p = argparse.ArgumentParser()
p.add_argument("--script", required=True, help="UTF-8 file containing a JS expression")
p.add_argument("--output", required=True)
p.add_argument("--target", required=True)
p.add_argument("--market", choices=["MY", "SG", "VN"], required=True)
p.add_argument("--path", required=True)
p.add_argument("--shop", required=True)
p.add_argument("--write", action="store_true")
a = p.parse_args()
root = Path(__file__).resolve().parent.parent
config = json.loads((root / "config/project-context.json").read_text(encoding="utf-8-sig"))
cli = config["official_ziniao_cli"]
expr = Path(a.script).read_text(encoding="utf-8-sig")
guard = {"market": a.market, "path": a.path, "shop": a.shop}
script = """(()=>{const g=GUARD;const u=new URL(location.href);
if(u.hostname!=='seller.tiktokshopglobalselling.com'||u.searchParams.get('shop_region')!==g.market||u.pathname!==g.path||!document.body.innerText.includes(g.shop))throw Error('Visible page identity mismatch');
return JSON.stringify({url:location.href,value:(EXPRESSION)});})()""".replace("GUARD", json.dumps(guard, ensure_ascii=False)).replace("EXPRESSION", expr)
out = Path(a.output)
out.parent.mkdir(parents=True, exist_ok=True)
checkpoint = {"started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "requested_target": a.target, "guard": guard,
              "write_attempted": a.write, "status": "dispatch_pending"}
out.write_text(json.dumps(checkpoint, ensure_ascii=False, indent=2), encoding="utf-8")
try:
    r = subprocess.run([cli["binary_path"], "page", "exec", "--store-id", cli["store_id"],
                        "--target-id", a.target, "--script", script],
                       capture_output=True, text=True, encoding="utf-8", timeout=45)
    payload = json.loads(r.stdout)
    inner = payload.get("data", {}).get("data", {})
    checkpoint.update(actual_target=inner.get("targetId"), exit_code=r.returncode)
    if r.returncode or not payload.get("ok") or inner.get("exceptionDetails"):
        checkpoint.update(status="unknown" if a.write else "failed", error=payload)
        raise RuntimeError("CLI or page exception; inspect the saved result before continuing")
    if inner.get("targetId") != a.target:
        checkpoint.update(status="unknown" if a.write else "failed", error="Returned target differs or is missing")
        raise RuntimeError(checkpoint["error"])
    value = inner.get("result")
    checkpoint.update(status="returned", result=json.loads(value) if isinstance(value, str) else value)
except Exception as e:
    checkpoint.setdefault("error", str(e))
    if checkpoint["status"] == "dispatch_pending":
        checkpoint["status"] = "unknown" if a.write else "failed"
    out.write_text(json.dumps(checkpoint, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(checkpoint, ensure_ascii=False))
    raise
out.write_text(json.dumps(checkpoint, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(checkpoint, ensure_ascii=False))
