import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StdioMcpClient, projectRoot, reportDir, safeKill, summarizeMessage } from './live-audit-lib.mjs';

function assertCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function containsNormalized(haystack, needle) {
  const normalize = (value) => String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  return normalize(haystack).includes(normalize(needle));
}

async function callTool(client, name, args, timeoutMs = 180000) {
  const raw = await client.request('tools/call', { name, arguments: args }, timeoutMs);
  const payload = raw?.result?.structuredContent;
  if (!payload?.ok) {
    throw new Error(`${name}: ${summarizeMessage(payload?.message || 'tool retornou erro')}`);
  }
  return payload;
}

async function runStep(report, label, fn) {
  const startedAt = Date.now();
  try {
    const data = await fn();
    report.steps.push({
      step: label,
      ok: true,
      duration_ms: Date.now() - startedAt,
      data,
    });
    return data;
  } catch (err) {
    report.steps.push({
      step: label,
      ok: false,
      duration_ms: Date.now() - startedAt,
      error: summarizeMessage(err),
    });
    throw err;
  }
}

async function main() {
  const report = {
    suite: {
      key: 'diario-deep',
      title: 'Diario Oficial Deep Audit',
      description: 'Fluxo investigativo real: listar periodo, detectar publicacao em mes seguinte, extrair PDF e modo leitura, e validar consistencia textual.',
    },
    generated_at: new Date().toISOString(),
    subject: {
      nome: 'Carlos Daniel Viana Ferrer',
      desligamento_data: '11/02/2026',
      periodo_sem_hit: { dataInicial: '01/02/2026', dataFinal: '28/02/2026' },
      periodo_com_hit: { dataInicial: '01/03/2026', dataFinal: '31/03/2026' },
    },
    steps: [],
  };

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

  try {
    await client.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'live-diary-deep-audit', version: '1.0.0' },
    }, 30000);
    client.notify('notifications/initialized', {});

    const secoes = await runStep(report, 'listar_secoes_diario', async () => {
      const payload = await callTool(client, 'listar_secoes_diario', {});
      assertCondition(Array.isArray(payload.data) && payload.data.length >= 5, 'listar_secoes_diario retornou secoes insuficientes');
      const atosOficiais = payload.data.find((item) => String(item.id_secao) === '1');
      assertCondition(!!atosOficiais, 'Secao Atos Oficiais nao encontrada');
      return {
        total_itens: payload.meta?.total_itens ?? payload.data.length,
        atos_oficiais: atosOficiais,
      };
    });

    await runStep(report, 'listar_diarios_por_secao', async () => {
      const payload = await callTool(client, 'listar_diarios_por_secao', {
        id_secao: secoes.atos_oficiais.id_secao,
        pagina: 1,
        por_pagina: 10,
      });
      assertCondition(Array.isArray(payload.data) && payload.data.length > 0, 'listar_diarios_por_secao nao retornou edicoes');
      return {
        total_itens: payload.meta?.total_itens ?? payload.data.length,
        amostra_ids: payload.data.slice(0, 3).map((item) => item.id_do),
      };
    });

    await runStep(report, 'listar_diarios_por_data_fevereiro', async () => {
      const payload = await callTool(client, 'listar_diarios_por_data', {
        dataInicial: report.subject.periodo_sem_hit.dataInicial,
        dataFinal: report.subject.periodo_sem_hit.dataFinal,
        pagina: 1,
        por_pagina: 10,
      });
      assertCondition(Array.isArray(payload.data) && payload.data.length > 0, 'Nao retornou diarios em fevereiro');
      return {
        total_itens: payload.meta?.total_itens ?? payload.data.length,
        primeira_data: payload.data[0]?.data_iso || payload.data[0]?.data,
      };
    });

    const diariosMarco = await runStep(report, 'listar_diarios_por_data_marco', async () => {
      const payload = await callTool(client, 'listar_diarios_por_data', {
        dataInicial: report.subject.periodo_com_hit.dataInicial,
        dataFinal: report.subject.periodo_com_hit.dataFinal,
        pagina: 1,
        por_pagina: 30,
      });
      assertCondition(Array.isArray(payload.data) && payload.data.length > 0, 'Nao retornou diarios em marco');
      return {
        total_itens: payload.meta?.total_itens ?? payload.data.length,
        items: payload.data,
      };
    });

    await runStep(report, 'consultar_diario_oficial_fevereiro_sem_hit', async () => {
      const payload = await callTool(client, 'consultar_diario_oficial', {
        termo: report.subject.nome,
        dataInicial: report.subject.periodo_sem_hit.dataInicial,
        dataFinal: report.subject.periodo_sem_hit.dataFinal,
        _por_pagina: 10,
      });
      const totalMatches = Number(payload.meta?.total_matches ?? payload.matches?.length ?? 0);
      assertCondition(totalMatches === 0, `Esperado 0 matches em fevereiro, veio ${totalMatches}`);
      return {
        total_matches: totalMatches,
        total_documentos_indexados: payload.meta?.total_documentos_indexados ?? null,
      };
    });

    const hitMarco = await runStep(report, 'consultar_diario_oficial_marco_com_hit', async () => {
      const payload = await callTool(client, 'consultar_diario_oficial', {
        termo: report.subject.nome,
        dataInicial: report.subject.periodo_com_hit.dataInicial,
        dataFinal: report.subject.periodo_com_hit.dataFinal,
        _por_pagina: 10,
      });
      const totalMatches = Number(payload.meta?.total_matches ?? payload.matches?.length ?? 0);
      assertCondition(totalMatches >= 1, 'Esperado match em marco e nao houve');
      const first = payload.matches?.[0];
      assertCondition(first?.documento?.id_do, 'Match de marco sem documento associado');
      assertCondition(String(first.documento.data_iso || '').startsWith('2026-03-'), 'Match principal nao caiu em marco/2026');
      assertCondition(containsNormalized(first.trecho, '11 de fevereiro de 2026'), 'Trecho do match nao menciona a data da saida');
      return {
        total_matches: totalMatches,
        documento: first.documento,
        pagina: first.pagina,
        trecho: first.trecho,
      };
    });

    await runStep(report, 'buscar_no_diario_marco_consistente', async () => {
      const payload = await callTool(client, 'buscar_no_diario', {
        termo: report.subject.nome,
        dataInicial: report.subject.periodo_com_hit.dataInicial,
        dataFinal: report.subject.periodo_com_hit.dataFinal,
        _por_pagina: 10,
      });
      const totalMatches = Number(payload.meta?.total_matches ?? payload.matches?.length ?? 0);
      assertCondition(totalMatches >= 1, 'buscar_no_diario nao retornou hit em marco');
      const first = payload.matches?.[0];
      assertCondition(String(first?.documento?.id_do) === String(hitMarco.documento.id_do), 'buscar_no_diario retornou documento diferente do consultar_diario_oficial');
      return {
        total_matches: totalMatches,
        documento_id: first.documento.id_do,
        pagina: first.pagina,
      };
    });

    await runStep(report, 'documento_hit_existe_na_listagem_marco', async () => {
      const found = diariosMarco.items.find((item) => String(item.id_do) === String(hitMarco.documento.id_do));
      assertCondition(!!found, 'Documento do hit nao apareceu na listagem de marco');
      return {
        documento_id: found.id_do,
        data_iso: found.data_iso,
        edicao_num: found.edicao_num,
      };
    });

    const pdfText = await runStep(report, 'extrair_texto_diario_pdf', async () => {
      const payload = await callTool(client, 'extrair_texto_diario', {
        url_pdf: hitMarco.documento.url_pdf_direto,
        _por_pagina: 20000,
      }, 240000);
      const texto = String(payload.texto || '');
      assertCondition(texto.length > 5000, 'Texto do PDF ficou curto demais');
      assertCondition(containsNormalized(texto, 'Municipio de Paraguacu Paulista'), 'Texto do PDF nao contem a identificacao do municipio');
      assertCondition(containsNormalized(texto, `Edicao nº ${hitMarco.documento.edicao_num}`), 'Texto do PDF nao contem a edicao esperada');
      return {
        texto_len: texto.length,
        contem_municipio: true,
        contem_edicao: true,
        observacao: 'Extracao do PDF valida a edicao correta; o ato nominal e validado no indice do diario e no modo leitura.',
      };
    });

    await runStep(report, 'extrair_texto_modo_leitura_html', async () => {
      const payload = await callTool(client, 'extrair_texto_modo_leitura', {
        url_modo_texto: hitMarco.documento.url_modo_texto,
        _por_pagina: 4000,
      }, 240000);
      const texto = String(payload.texto || '');
      assertCondition(texto.length > 1000, 'Texto do modo leitura ficou curto demais');
      const modoIndisponivel = containsNormalized(texto, 'Modo texto indisponivel');
      if (!modoIndisponivel) {
        assertCondition(containsNormalized(texto, report.subject.nome), 'Texto do modo leitura nao contem o nome do servidor');
        assertCondition(containsNormalized(texto, '11 de fevereiro de 2026'), 'Texto do modo leitura nao contem a data da saida');
        assertCondition(containsNormalized(texto, 'exonerar, por pedido'), 'Texto do modo leitura nao contem o ato esperado');
      } else {
        assertCondition(containsNormalized(texto, `Edicao nº ${hitMarco.documento.edicao_num}`), 'Pagina de modo leitura indisponivel nao referencia a edicao esperada');
      }
      return {
        texto_len: texto.length,
        modo_texto_disponivel: !modoIndisponivel,
        contem_nome: !modoIndisponivel,
        contem_data_saida: !modoIndisponivel,
        contem_ato: !modoIndisponivel,
        observacao: modoIndisponivel
          ? 'A edicao alvo nao expoe conteudo textual no portal; a tool retornou corretamente o marcador de indisponibilidade.'
          : 'A edicao alvo expoe o ato diretamente em HTML legivel.',
      };
    });

    report.ok = true;
  } catch (err) {
    report.ok = false;
    report.error = summarizeMessage(err);
    process.exitCode = 1;
  } finally {
    safeKill(child);
    report.stderr_tail = stderrBuffer.slice(-3000);
  }

  const reportPath = path.join(reportDir, 'live-diary-deep-audit.json');
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');

  console.log(`[diario-deep] Report: ${reportPath}`);
  console.log(`[diario-deep] Steps: ${report.steps.filter((step) => step.ok).length}/${report.steps.length} ok`);
  if (!report.ok) {
    console.log(`[diario-deep] Error: ${report.error}`);
  }

  if (!report.ok) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Live diary deep audit failed: ${err instanceof Error ? err.stack || err.message : String(err)}`);
  process.exit(1);
});
