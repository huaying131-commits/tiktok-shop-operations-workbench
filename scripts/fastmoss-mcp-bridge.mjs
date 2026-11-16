// Adapt the official Streamable HTTP MCP service to Codex stdio. Credentials
// stay in the official local CLI state; no key is put in process arguments,
// Codex configuration, or diagnostic output.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

let client;
let transport;
let server;
let stage = 'credential';
const requestOptions = { timeout: 30000 };
async function close() {
  try { await server?.close(); } catch {}
  try { await client?.close(); } catch {}
}
try {
  const state = JSON.parse(await fs.readFile(path.join(os.homedir(), '.fastmoss-mcp', 'state.json'), 'utf8'));
  if (typeof state.api_key !== 'string' || !state.api_key.trim()) {
    process.stderr.write('FASTMOSS_AUTH_REQUIRED: enter the API Key locally first.\n');
    process.exitCode = 2;
  } else {
    const url = new URL('https://mcp.fastmoss.com/mcp');
    url.searchParams.set('api_key', state.api_key.trim());
    state.api_key = undefined;
    transport = new StreamableHTTPClientTransport(url);
    client = new Client({ name: 'dalei-fastmoss-bridge', version: '1.0.0' });
    client.onerror = () => {}; // Never print a remote URL that contains the key.
    transport.onerror = () => {};
    stage = 'connect';
    await client.connect(transport, { timeout: 15000 });
    if (process.argv.includes('--check')) {
      stage = 'list_tools';
      const response = await client.listTools({}, requestOptions);
      const report = {
        connected: true,
        server: client.getServerVersion(),
        tools: response.tools.map(t => t.name),
        next_cursor: response.nextCursor ?? null,
        checked_at: new Date().toISOString()
      };
      const manifestIndex = process.argv.indexOf('--manifest-path');
      if (manifestIndex >= 0) {
        const target = process.argv[manifestIndex + 1];
        if (!target) throw new Error('MANIFEST_PATH_REQUIRED');
        await fs.writeFile(target, JSON.stringify({ ...report, schemas: response.tools }, null, 2));
      }
      process.stdout.write(JSON.stringify(report) + '\n');
      await close();
    } else {
      server = new Server({ name: 'dalei-fastmoss-bridge', version: '1.0.0' }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async request => {
        try { return await client.listTools(request.params ?? {}, requestOptions); }
        catch { throw new Error('FASTMOSS_LIST_FAILED: check account authorization and connectivity.'); }
      });
      server.setRequestHandler(CallToolRequestSchema, async request => {
        try { return await client.callTool(request.params, undefined, requestOptions); }
        catch { return { isError: true, content: [{ type: 'text', text: 'FASTMOSS_CALL_FAILED: check the live schema, permissions, quota, and connectivity.' }] }; }
      });
      server.onerror = () => {};
      await server.connect(new StdioServerTransport());
      process.stdin.on('end', () => { void close(); });
      for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => { void close(); });
    }
  }
} catch {
  process.stderr.write(`FASTMOSS_SETUP_FAILED: ${stage}. No credentials are included in this diagnostic.\n`);
  await close();
  process.exitCode = 1;
}
