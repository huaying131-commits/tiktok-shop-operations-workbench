"""Run the installed official CLI without secrets in argv or saved diagnostics."""
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')

parser = argparse.ArgumentParser()
parser.add_argument('--out', type=Path)
parser.add_argument('cli_args', nargs=argparse.REMAINDER)
options = parser.parse_args()
args = options.cli_args
if args and args[0] == '--':
    args = args[1:]
if not args or args[0] not in {'whoami', 'tools', 'call', 'show', '--version'}:
    parser.error('Only status, discovery, and data calls are supported.')
if any(x in args for x in ('--api-key', '--base-url', '--insecure-skip-tls')):
    parser.error('Credential arguments and endpoint overrides are not supported.')
if args[0] == 'call' and '--client-name' not in args:
    args += ['--client-name', 'dalei-shop-ops', '--client-version', '1.0.0']
state_file = Path.home() / '.fastmoss-mcp' / 'state.json'
state = json.loads(state_file.read_text(encoding='utf-8-sig')) if state_file.exists() else {}
key = state.get('api_key', '')
binary = (Path.home() / 'AppData/Roaming/npm/node_modules/@fastmoss/cli'
          / 'node_modules/@fastmoss/cli-windows-amd64/bin/fastmoss-windows-amd64.exe')
try:
    result = subprocess.run([str(binary), *args], capture_output=True, timeout=60)
except subprocess.TimeoutExpired:
    raise SystemExit('FASTMOSS_QUERY_TIMEOUT: no raw request or credential logged.')
raw_output = result.stdout + result.stderr
try:
    output = raw_output.decode('utf-8')
except UnicodeDecodeError:
    output = raw_output.decode('gb18030', errors='replace')
if key:
    output = output.replace(key, '[REDACTED]')
output = re.sub(r'api_key=[^&\s"\x27]+', 'api_key=[REDACTED]', output)
if options.out:
    options.out.parent.mkdir(parents=True, exist_ok=True)
    options.out.write_text(output, encoding='utf-8')
print(output, end='')
raise SystemExit(result.returncode)
