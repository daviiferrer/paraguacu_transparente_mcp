import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const serverEntry = path.join(projectRoot, 'dist', 'index.js');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout: ${label} (${ms}ms)`)), ms)),
  ]);
}

function spawnServer(env = {}) {
  const child = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf-8');
  });

  return { child, getStderr: () => stderr };
}

function safeKill(child) {
  if (!child || child.killed) return;
  try {
    child.kill('SIGTERM');
  } catch {}
}

async function getFreePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = Number(address.port);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

class StdioRpcClient {
  constructor(child) {
    this.child = child;
    this.id = 1;
    this.buffer = '';
    this.pending = new Map();

    child.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString('utf-8');
      this.flush();
    });

    child.on('exit', (code, signal) => {
      for (const [, pending] of this.pending) {
        pending.reject(new Error(`Processo MCP finalizou inesperadamente (code=${code}, signal=${signal})`));
      }
      this.pending.clear();
    });
  }

  flush() {
    let lineBreak = this.buffer.indexOf('\n');
    while (lineBreak !== -1) {
      const line = this.buffer.slice(0, lineBreak).trim();
      this.buffer = this.buffer.slice(lineBreak + 1);

      if (line) {
        try {
          const message = JSON.parse(line);
          if (message.id !== undefined && this.pending.has(message.id)) {
            const pending = this.pending.get(message.id);
            this.pending.delete(message.id);
            pending.resolve(message);
          }
        } catch {
          // Ignora linhas não-JSON para robustez.
        }
      }

      lineBreak = this.buffer.indexOf('\n');
    }
  }

  send(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async request(method, params) {
    const id = this.id++;
    const message = { jsonrpc: '2.0', id, method, params };
    this.send(message);

    return withTimeout(
      new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
      }),
      15000,
      `stdio request ${method}`,
    );
  }

  notify(method, params = {}) {
    this.send({ jsonrpc: '2.0', method, params });
  }
}

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': '2025-06-18',
      ...headers,
    },
    body: JSON.stringify(body),
  });

  const raw = await response.text();
  let json = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = null;
  }

  return { response, json, raw };
}

async function waitForHealth(baseUrl, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {
      // ainda subindo
    }
    await sleep(150);
  }
  throw new Error(`Servidor HTTP não subiu em ${timeoutMs}ms`);
}

test('integração stdio: initialize + tools/list + tools/call', { timeout: 30000 }, async (t) => {
  const { child, getStderr } = spawnServer({ MCP_TRANSPORT: 'stdio' });
  t.after(() => safeKill(child));

  const rpc = new StdioRpcClient(child);

  const init = await rpc.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test-suite', version: '1.0.0' },
  });

  assert.ok(init.result);
  assert.equal(init.result.serverInfo?.name, 'portal-transparencia');
  assert.ok(init.result.capabilities?.tools);

  rpc.notify('notifications/initialized', {});

  const list = await rpc.request('tools/list', {});
  assert.ok(Array.isArray(list.result?.tools));
  assert.ok(list.result.tools.some((tool) => tool.name === 'listar_categorias'));

  const call = await rpc.request('tools/call', {
    name: 'listar_categorias',
    arguments: { pagina: 1, por_pagina: 3 },
  });

  assert.ok(Array.isArray(call.result?.content));
  assert.ok(call.result.content.length > 0);
  const payload = JSON.parse(call.result.content[0].text);
  assert.equal(payload.ok, true);
  assert.ok(Array.isArray(payload.itens));

  if (child.exitCode !== null && child.exitCode !== 0) {
    throw new Error(`Processo stdio finalizou com erro. stderr:\n${getStderr()}`);
  }
});

test('integração HTTP streamable: /health + initialize + tools/list + tools/call', { timeout: 40000 }, async (t) => {
  const port = await getFreePort();
  const { child, getStderr } = spawnServer({
    MCP_TRANSPORT: 'http',
    HOST: '127.0.0.1',
    PORT: String(port),
    MCP_ALLOWED_HOSTS: '127.0.0.1,localhost',
  });
  t.after(() => safeKill(child));

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl);

  const initReq = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-suite-http', version: '1.0.0' },
    },
  };

  const init = await postJson(`${baseUrl}/mcp`, initReq);
  assert.equal(init.response.status, 200, `initialize HTTP inesperado: ${init.raw}`);
  assert.ok(init.json?.result);
  assert.equal(init.json.result.serverInfo?.name, 'portal-transparencia');

  const sessionId = init.response.headers.get('mcp-session-id');
  assert.ok(sessionId, 'Mcp-Session-Id ausente no initialize');

  const commonHeaders = {
    'MCP-Session-Id': sessionId,
  };

  const initialized = await postJson(
    `${baseUrl}/mcp`,
    { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
    commonHeaders,
  );
  assert.ok(
    initialized.response.status === 202 || initialized.response.status === 200,
    `initialized status inesperado: ${initialized.response.status}`,
  );

  const list = await postJson(
    `${baseUrl}/mcp`,
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    commonHeaders,
  );
  assert.equal(list.response.status, 200, `tools/list HTTP inesperado: ${list.raw}`);
  assert.ok(Array.isArray(list.json?.result?.tools));
  assert.ok(list.json.result.tools.some((tool) => tool.name === 'listar_categorias'));

  const call = await postJson(
    `${baseUrl}/mcp`,
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'listar_categorias',
        arguments: { pagina: 1, por_pagina: 3 },
      },
    },
    commonHeaders,
  );
  assert.equal(call.response.status, 200, `tools/call HTTP inesperado: ${call.raw}`);
  assert.ok(Array.isArray(call.json?.result?.content));
  const payload = JSON.parse(call.json.result.content[0].text);
  assert.equal(payload.ok, true);

  if (child.exitCode !== null && child.exitCode !== 0) {
    throw new Error(`Processo HTTP finalizou com erro. stderr:\n${getStderr()}`);
  }
});
