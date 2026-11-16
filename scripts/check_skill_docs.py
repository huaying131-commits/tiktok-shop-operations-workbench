"""Validate this skill's simple two-field frontmatter and local reference links."""
import json
import re
from pathlib import Path

root = Path('skills/dalei-tiktok-shop-ops')
text = (root / 'SKILL.md').read_text(encoding='utf-8')
front = re.match(r'\A---\nname: ([a-z0-9-]+)\ndescription: ([^\n]+)\n---\n', text)
assert front, 'Expected simple name/description frontmatter'
assert len(front[1]) <= 64 and '--' not in front[1]
assert front[1] == 'dalei-tiktok-shop-ops'
assert len(front[2]) <= 1024 and '<' not in front[2] and '>' not in front[2]
assert ': ' not in front[2] and ' #' not in front[2], 'Quote YAML-sensitive text'
links = []
for doc in root.rglob('*.md'):
    for dest in re.findall(r'\]\(([^)]+)\)', doc.read_text(encoding='utf-8')):
        if not re.match(r'[a-z]+://', dest) and not dest.startswith('#'):
            target = (doc.parent / dest.split('#')[0]).resolve()
            assert target.exists(), f'Missing reference: {doc}: {dest}'
            links.append(str(target))
for p in ['config/project-context.json', 'installation-status.json']:
    json.loads(Path(p).read_text(encoding='utf-8'))
print(json.dumps({'basic_frontmatter_check': 'passed', 'local_links_checked': len(links),
                  'project_json': 'passed', 'full_yaml_validator': 'not_run_missing_pyyaml'}))
