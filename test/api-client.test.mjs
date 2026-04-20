import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { FiorilliApiClient } from '../dist/api-client.js';

async function createServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function withEnv(envUpdates, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(envUpdates)) {
    previous[key] = process.env[key];
    if (value === undefined || value === null) {
      delete process.env[key];
    } else {
      process.env[key] = String(value);
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function closeClientDb(client) {
  try {
    client?.diarioIndex?.db?.close?.();
  } catch {}
}

test('request retorna JSON parseado em caso de sucesso', async () => {
  const srv = await createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([{ ok: true }]));
  });

  try {
    const client = new FiorilliApiClient(srv.baseUrl);
    const out = await client.request('/VersaoJson/Despesas/', { Listagem: 'Teste' });
    assert.deepEqual(out, [{ ok: true }]);
    closeClientDb(client);
  } finally {
    await srv.close();
  }
});

test('request aceita HTML para DefineExercicio', async () => {
  const srv = await createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body>ok</body></html>');
  });

  try {
    const client = new FiorilliApiClient(srv.baseUrl);
    const out = await client.request('/VersaoJson/Despesas/', { Listagem: 'DefineExercicio' });
    assert.equal(out.status, 'ok');
    assert.equal(out.listagem, 'DefineExercicio');
    closeClientDb(client);
  } finally {
    await srv.close();
  }
});

test('request faz retry em erro 500 e recupera na tentativa seguinte', async () => {
  let hits = 0;
  const srv = await createServer((_req, res) => {
    hits += 1;
    if (hits === 1) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('temporary error');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, hit: hits }));
  });

  try {
    await withEnv(
      { MCP_FIORILLI_MAX_RETRIES: '2', MCP_RETRY_BASE_DELAY_MS: '1' },
      async () => {
        const client = new FiorilliApiClient(srv.baseUrl);
        const out = await client.request('/VersaoJson/Despesas/', { Listagem: 'Teste' });
        assert.equal(out.ok, true);
        assert.equal(hits, 2);
        closeClientDb(client);
      },
    );
  } finally {
    await srv.close();
  }
});

test('request reaproveita cookie de sessão entre chamadas', async () => {
  const srv = await createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/set-cookie') {
      res.setHeader('Set-Cookie', 'ASP.NET_SessionId=abc123; Path=/');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === '/check-cookie') {
      const cookie = req.headers.cookie || '';
      if (String(cookie).includes('ASP.NET_SessionId=abc123')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        res.end('missing cookie');
      }
      return;
    }

    res.writeHead(404);
    res.end();
  });

  try {
    const client = new FiorilliApiClient(srv.baseUrl);
    await client.request('/set-cookie', { Listagem: 'A' });
    const out = await client.request('/check-cookie', { Listagem: 'B' });
    assert.equal(out.ok, true);
    closeClientDb(client);
  } finally {
    await srv.close();
  }
});

test('extrairTextoModoLeitura limpa HTML e preserva conteúdo útil', async () => {
  const srv = await createServer((_req, res) => {
    const html = `
      <html>
        <head>
          <style>.x { color: red; }</style>
          <script>console.log('x')</script>
        </head>
        <body>
          <div>
            <h1>Diário Oficial</h1>
            <p>Este é um texto longo o suficiente para validar a extração em modo leitura.</p>
            <p>Carlos Daniel Viana Ferrer aparece neste conteúdo oficial.</p>
          </div>
        </body>
      </html>
    `;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  });

  try {
    const client = new FiorilliApiClient('http://placeholder.local');
    const text = await client.extrairTextoModoLeitura(`${srv.baseUrl}/leitura`);
    assert.match(text, /Carlos Daniel Viana Ferrer/);
    assert.equal(text.includes('<script>'), false);
    closeClientDb(client);
  } finally {
    await srv.close();
  }
});

test('buscarDiarioPorTermo aceita janela ISO e filtra candidatos corretamente', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-api-client-'));
  await withEnv({ MCP_DATA_DIR: tempDir }, async () => {
    const client = new FiorilliApiClient('http://placeholder.local');

    const docs = [
      {
        id_do: '1',
        data: '10/01/2026',
        data_iso: '2026-01-10',
        edicao_num: '1275',
        edicao_ano: '2026',
        paginas: 1,
        flag_extra: false,
        url_original_eletronico: 'https://dosp.com.br/exibe_do.php?i=jan',
        url_modo_texto: 'https://imprensaoficialmunicipal.com.br/leiturajornal.php?i=jan',
        url_pdf_direto: 'https://dosp.com.br/exibe_do.php?i=jan',
      },
      {
        id_do: '2',
        data: '15/02/2026',
        data_iso: '2026-02-15',
        edicao_num: '1280',
        edicao_ano: '2026',
        paginas: 1,
        flag_extra: false,
        url_original_eletronico: 'https://dosp.com.br/exibe_do.php?i=feb',
        url_modo_texto: 'https://imprensaoficialmunicipal.com.br/leiturajornal.php?i=feb',
        url_pdf_direto: 'https://dosp.com.br/exibe_do.php?i=feb',
      },
    ];

    client.listarDiarios = async () => ({
      edicoes: docs,
      total: docs.length,
      pagina: 1,
      total_paginas: 1,
    });

    client.extrairPdfPaginasComLock = async (url) => ({
      total_paginas: 1,
      paginas: [url.includes('jan') ? 'Carlos Daniel Viana Ferrer no diário' : 'Outro conteúdo'],
    });

    const out = await client.buscarDiarioPorTermo(
      'Carlos',
      '2026-01-01',
      '2026-01-31',
      'pdf',
      { offset: 0, limit: 10 },
    );

    assert.equal(out.total_candidatos, 1);
    assert.equal(out.documentos_processados, 1);
    assert.equal(out.scan_completo, true);
    assert.equal(out.total_matches >= 1, true);

    closeClientDb(client);
  });
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});

test('formatarItemDiario corrige edicao_ano invalido e parseDateInput valida datas reais', async () => {
  const client = new FiorilliApiClient('http://placeholder.local');
  const formatted = client.formatarItemDiario({
    iddo: 787146,
    data: '2026-03-09',
    edicao_do: 1275,
    ano_do: '2',
    pgtotal: 321,
    flag_extra: 0,
  });

  assert.equal(formatted.edicao_ano, '2026');
  assert.equal(formatted.data_iso, '2026-03-09');
  assert.equal(client.parseDateInput('31/02/2026'), null);
  assert.equal(client.parseDateInput('2026-02-31'), null);
  assert.ok(client.parseDateInput('09/03/2026') instanceof Date);
  closeClientDb(client);
});

test('parseDespesasGeraisRows e pager extraem dados da tela oficial', async () => {
  const client = new FiorilliApiClient('http://placeholder.local');
  const fixturePath = path.join(process.cwd(), '.mcp-data', 'DespesasPorEntidade-response.html');
  const html = fs.readFileSync(fixturePath, 'utf8');

  const rows = client.parseDespesasGeraisRows(html);
  const summary = client.parsePagerSummary(html);
  const totals = client.parseDespesasGeraisTotals(html);
  const hidden = client.extractHiddenInputs(html);

  assert.equal(rows.length, 25);
  assert.equal(rows[0].CODIGO, '1');
  assert.equal(rows[0].TPEM, 'GL');
  assert.match(rows[0].NOMEFOR || '', /NS KARYDI/);
  assert.equal(summary.pagina_atual, 1);
  assert.equal(summary.total_paginas, 197);
  assert.equal(summary.total_linhas, 4910);
  assert.equal(totals.EMPENHADO, '118.687.768,44');
  assert.ok(typeof hidden.__VIEWSTATE === 'string' && hidden.__VIEWSTATE.length > 0);
  assert.ok(typeof hidden['gridDespesas$CallbackState'] === 'string' && hidden['gridDespesas$CallbackState'].length > 0);
  closeClientDb(client);
});

test('parseCallbackResult extrai html util do callback ASPxGridView', async () => {
  const client = new FiorilliApiClient('http://placeholder.local');
  const fixturePath = path.join(process.cwd(), '.mcp-data', 'DespesasPorEntidade-callback-122-response.txt');
  const raw = fs.readFileSync(fixturePath, 'utf8');

  const html = client.parseCallbackResult(raw);
  const summary = client.parsePagerSummary(html);
  const hidden = client.extractHiddenInputs(html);

  assert.match(html, /gridDespesas_DXMainTable/);
  assert.ok(summary.total_paginas >= 0);
  assert.ok(typeof hidden['gridDespesas$CallbackState'] === 'string' && hidden['gridDespesas$CallbackState'].length > 0);
  closeClientDb(client);
});
