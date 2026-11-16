import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const entry = fileURLToPath(new URL('../apps/customer-service/server.mjs', import.meta.url));

test('operations routes open new pages, reuse validators, and accept only same-origin refresh', { timeout: 35_000 }, async t => {
  const server = spawn(process.execPath, [entry], {
    env: { ...process.env, DESK_PORT: '0', TTS_OPERATIONS_BOARD: '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
    windowsHide: true,
  });
  t.after(() => server.kill());
  const lines = createInterface({ input: server.stdout });
  t.after(() => lines.close());
  const origin = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('exit', code => reject(new Error(`Workbench exited with ${code}`)));
    lines.on('line', line => {
      const address = line.match(/http:\/\/127\.0\.0\.1:\d+/u);
      if (address) resolve(address[0]);
    });
  });

  for (const [role, tab, section] of [
    ['ads-analysis', 'ads', 'ads-tasks'],
    ['procurement', 'inventory', 'procurement-tasks'],
    ['video-production', 'content', 'production-tasks'],
    ['video-publishing', 'publishing', 'publish-review'],
  ]) {
    const bookmark = await fetch(`${origin}/operations?role=${role}`, { redirect: 'manual' });
    assert.equal(bookmark.status, 302);
    assert.equal(bookmark.headers.get('location'), `/operations?tab=${tab}#${section}`);
    await bookmark.text();
  }

  for (const path of ['/operations', '/operations?tab=ads', '/operations?tab=orders', '/operations?tab=products']) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /operations-dashboard-live\.js/u);
  }
  const legacy = await fetch(origin + '/operations?view=legacy&role=ads-analysis');
  assert.match(await legacy.text(), /src="\/operations\.js"/u);

  const dashboard = origin + '/api/operations/dashboard';
  const result = await fetch(dashboard);
  assert.equal(result.status, 200);
  const validator = result.headers.get('etag');
  assert.match(validator ?? '', /^"[A-Za-z0-9_-]+"$/u);
  assert.equal((await result.json()).schema, 'operations-dashboard/v1');
  const unchanged = await fetch(dashboard, { headers: { 'If-None-Match': validator } });
  assert.equal(unchanged.status, 304);
  assert.equal(await unchanged.text(), '');
  const refresh = dashboard + '/refresh';
  assert.equal((await fetch(refresh, { method: 'POST' })).status, 403);
  assert.equal((await fetch(refresh, { method: 'POST', headers: { Origin: 'http://unrelated.test' } })).status, 403);
  const accepted = await fetch(refresh, { method: 'POST', headers: { Origin: origin } });
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), { accepted: false });
});
