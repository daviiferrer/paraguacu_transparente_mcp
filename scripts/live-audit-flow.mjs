import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ALL_TOOLS } from '../dist/tools.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const reportPath = path.join(projectRoot, '.mcp-data', 'live-audit-report.json');

function nowIso() {
  return new Date().toISOString();
}

class StdioMcpClient {
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
        pending.reject(new Error(`MCP process exited unexpectedly (code=${code}, signal=${signal})`));
      }
      this.pending.clear();
    });
  }

  flush() {
    let idx = this.buffer.indexOf('\n');
    while (idx >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) {
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined && this.pending.has(msg.id)) {
            const pending = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            pending.resolve(msg);
          }
        } catch {
          // ignore non-json lines
        }
      }
      idx = this.buffer.indexOf('\n');
    }
  }

  async request(method, params, timeoutMs = 120000) {
    const id = this.id++;
    const payload = { jsonrpc: '2.0', id, method, params };
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout on request ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }
}

function safeKill(child) {
  if (!child || child.killed) return;
  try {
    child.kill('SIGTERM');
  } catch {}
}

function summarizeMessage(value) {
  const msg = String(value || '').trim();
  if (!msg) return '';
  const firstLine = msg.split('\n')[0].trim();
  return firstLine.length > 260 ? `${firstLine.slice(0, 257)}...` : firstLine;
}

function buildDefaultSeed() {
  return {
    Empresa: '1',
    Exercicio: '2026',
    ConectarExercicio: '2026',
    DiaInicioPeriodo: '01',
    MesInicialPeriodo: '01',
    DiaFinalPeriodo: '31',
    MesFinalPeriodo: '01',
    intNumeroEmpenho: '1',
    strTipoEmpenho: 'OR',
    strNumeroPagto: '1',
    strNumeroLiquidacao: '1',
    strTipoLista: 'Empenhado',
    Codigochave: '1',
    id_secao: '1',
    dataInicial: '01/03/2026',
    dataFinal: '31/03/2026',
    termo: 'Carlos Daniel Viana Ferrer',
    url_pdf: 'https://dosp.com.br/exibe_do.php?i=Nzg3MTQ2',
    url_modo_texto: 'https://imprensaoficialmunicipal.com.br/leiturajornal.php?c=Paragua%C3%A7u%20Paulista&i=Nzg3MTQ2',
  };
}

function argsForTool(tool, seed) {
  const args = {};
  for (const param of tool.params) {
    if (!param.required) continue;
    args[param.name] = seed[param.name] ?? '1';
  }

  if (tool.name === 'consultar_diario_oficial' || tool.name === 'buscar_no_diario') {
    args.dataInicial = seed.dataInicial;
    args.dataFinal = seed.dataFinal;
    args._por_pagina = 5;
  }

  if (tool.name === 'extrair_texto_diario' || tool.name === 'extrair_texto_modo_leitura') {
    args._por_pagina = 1200;
  }

  if (tool.name === 'despesas_ordem_pagto_detalhes' || tool.name === 'despesas_ordem_pagto_parcelas' || tool.name === 'despesas_ordem_pagto_cheques') {
    // OR has returned 500 for this endpoint in production; ES remains stable for schema checks.
    args.strTipoEmpenho = 'ES';
  }

  if (tool.name === 'despesas_por_exigibilidade') {
    args.DiaInicioPeriodo = '01.01.2026';
    args.DiaFinalPeriodo = '31.01.2026';
    args.strTipoLista = '1';
  }

  return args;
}

async function discoverSeeds(client, seed) {
  const discoveries = [];

  try {
    const diarios = await client.request('tools/call', {
      name: 'listar_diarios',
      arguments: { pagina: 1, por_pagina: 1 },
    });
    const payload = diarios?.result?.structuredContent;
    const first = payload?.data?.[0];
    if (payload?.ok && first) {
      if (first.url_pdf_direto) seed.url_pdf = String(first.url_pdf_direto);
      if (first.url_modo_texto) seed.url_modo_texto = String(first.url_modo_texto);
      discoveries.push('listar_diarios seed: urls de diario capturadas');
    } else {
      discoveries.push(`listar_diarios seed: nao retornou item util (${summarizeMessage(payload?.message)})`);
    }
  } catch (err) {
    discoveries.push(`listar_diarios seed error: ${summarizeMessage(err)}`);
  }

  try {
    const diarias = await client.request('tools/call', {
      name: 'despesas_diarias',
      arguments: {
        DiaInicioPeriodo: '01',
        MesInicialPeriodo: '01',
        DiaFinalPeriodo: '31',
        MesFinalPeriodo: '03',
        Exercicio: seed.Exercicio,
        Empresa: seed.Empresa,
        _por_pagina: 1,
      },
    });
    const payload = diarias?.result?.structuredContent;
    const first = payload?.data?.[0];
    if (payload?.ok && first) {
      if (first.NEMPG) seed.intNumeroEmpenho = String(first.NEMPG);
      if (first.ORDEMPAGAMENTO) seed.strNumeroPagto = String(first.ORDEMPAGAMENTO);
      if (first.NUMEROLIQUIDACAO) seed.strNumeroLiquidacao = String(first.NUMEROLIQUIDACAO);
      discoveries.push(`despesas_diarias seed: empenho=${seed.intNumeroEmpenho}, op=${seed.strNumeroPagto}, liq=${seed.strNumeroLiquidacao}`);
    } else {
      discoveries.push(`despesas_diarias seed: sem item util (${summarizeMessage(payload?.message)})`);
    }
  } catch (err) {
    discoveries.push(`despesas_diarias seed error: ${summarizeMessage(err)}`);
  }

  return discoveries;
}

function classifyFailure(message) {
  const msg = String(message || '');
  if (msg.includes('HTTP 500')) return 'upstream_500';
  if (msg.includes('Timeout')) return 'timeout';
  if (msg.includes('Parametros invalidos')) return 'validation';
  return 'other';
}

async function main() {
  const failOnError = process.argv.includes('--fail-on-error');
  const startedAt = Date.now();

  const child = spawn(process.execPath, ['dist/index.js'], {
    cwd: projectRoot,
    env: { ...process.env, MCP_TRANSPORT: 'stdio' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderrBuffer = '';
  child.stderr.on('data', (chunk) => {
    stderrBuffer += chunk.toString('utf-8');
  });

  const client = new StdioMcpClient(child);
  const seed = buildDefaultSeed();
  const perTool = [];
  const discoveries = [];

  try {
    await client.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'live-audit-flow', version: '1.0.0' },
    }, 30000);
    client.notify('notifications/initialized', {});

    discoveries.push(...(await discoverSeeds(client, seed)));

    for (const tool of ALL_TOOLS) {
      const args = argsForTool(tool, seed);
      const start = Date.now();
      try {
        const raw = await client.request('tools/call', {
          name: tool.name,
          arguments: args,
        }, 180000);
        const payload = raw?.result?.structuredContent || null;
        const ok = payload?.ok === true;
        const message = summarizeMessage(payload?.message);
        perTool.push({
          tool: tool.name,
          category: tool.category,
          ok,
          duration_ms: Date.now() - start,
          rows: Array.isArray(payload?.data)
            ? payload.data.length
            : Array.isArray(payload?.matches)
              ? payload.matches.length
              : null,
          message: ok ? '' : message,
          failure_type: ok ? '' : classifyFailure(message),
          args_used: args,
        });
      } catch (err) {
        const message = summarizeMessage(err);
        perTool.push({
          tool: tool.name,
          category: tool.category,
          ok: false,
          duration_ms: Date.now() - start,
          rows: null,
          message,
          failure_type: classifyFailure(message),
          args_used: args,
        });
      }
    }
  } finally {
    safeKill(child);
  }

  const total = perTool.length;
  const success = perTool.filter((item) => item.ok).length;
  const failed = perTool.filter((item) => !item.ok);
  const failuresByType = failed.reduce((acc, item) => {
    const key = item.failure_type || 'other';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  const report = {
    started_at: nowIso(),
    duration_ms: Date.now() - startedAt,
    server_transport: 'stdio',
    total_tools: total,
    succeeded_tools: success,
    failed_tools: failed.length,
    failures_by_type: failuresByType,
    discoveries,
    seed,
    results: perTool,
    stderr_tail: stderrBuffer.slice(-3000),
  };

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');

  console.log('Live audit flow finished.');
  console.log(`Tools: ${success}/${total} succeeded, ${failed.length} failed.`);
  console.log(`Report: ${reportPath}`);
  if (discoveries.length > 0) {
    console.log('Discoveries:');
    for (const item of discoveries) console.log(`- ${item}`);
  }
  if (failed.length > 0) {
    console.log('Failures:');
    for (const item of failed) {
      console.log(`- ${item.tool} [${item.failure_type}] ${item.message}`);
    }
  }

  if (failOnError && failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`Live audit flow failed: ${err instanceof Error ? err.stack || err.message : String(err)}`);
  process.exit(1);
});
