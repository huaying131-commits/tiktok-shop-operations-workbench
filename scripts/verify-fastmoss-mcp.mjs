// Exercise the actual Codex stdio command, not just the remote HTTP endpoint.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const client = new Client({ name: 'dalei-fastmoss-smoke', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('./fastmoss-mcp-bridge.mjs', import.meta.url))],
  stderr: 'pipe'
});
client.onerror = () => {};
transport.onerror = () => {};
let stage = 'stdio_connect';
try {
  await client.connect(transport, { timeout: 30000 });
  stage = 'tools_list';
  const result = await client.listTools({}, { timeout: 30000 });
  const report = {
    connected: true,
    transport: 'stdio_to_official_streamable_http',
    server: client.getServerVersion(),
    tool_count: result.tools.length,
    tool_names: result.tools.map(x => x.name),
    next_cursor: result.nextCursor ?? null,
    checked_at: new Date().toISOString()
  };
  const output = process.argv[2];
  const requestFile = process.argv[3];
  let toolResult;
  if (requestFile) {
    const request = JSON.parse(await fs.readFile(path.resolve(requestFile), 'utf8'));
    const schema = result.tools.find(t => t.name === request.name);
    if (!schema) throw new Error('TOOL_NOT_IN_LIVE_CATALOG');
    stage = 'tools_call';
    toolResult = await client.callTool({ name: request.name, arguments: request.arguments ?? {} }, undefined, { timeout: 30000 });
    report.test_tool = request.name;
    report.test_is_error = toolResult.isError ?? false;
    report.charge = toolResult._meta?.charge ?? null;
    if (toolResult.isError) process.exitCode = 1;
  }
  if (output) await fs.writeFile(path.resolve(output), JSON.stringify({ ...report, schemas: result.tools, test_result: toolResult }, null, 2));
  process.stdout.write(JSON.stringify(report) + '\n');
  if (toolResult) process.stdout.write(JSON.stringify(toolResult) + '\n');
} catch {
  process.stderr.write(`FASTMOSS_MCP_VERIFICATION_FAILED: ${stage}. No raw request logged.\n`);
  process.exitCode = 1;
} finally {
  try { await client.close(); } catch {}
}
