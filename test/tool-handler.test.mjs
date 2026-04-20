import test from 'node:test';
import assert from 'node:assert/strict';
import { callTool, listTools } from '../dist/tool-handler.js';

function makeState(overrides = {}) {
  return {
    config: {
      baseUrl: 'http://localhost:9999/transparencia',
      empresa: '1',
      exercicio: '2026',
    },
    apiClient: {
      request: async () => [],
      buscarDiarioPorTermo: async () => ({
        termo: 'x',
        fonte: 'pdf',
        total_candidatos: 0,
        documentos_processados: 0,
        scan_completo: true,
        proximo_offset: undefined,
        total_documentos_com_match: 0,
        total_documentos_indexados: 0,
        total_matches: 0,
        matches: [],
        falhas: [],
      }),
      listarDiarios: async () => ({ edicoes: [], total: 0, pagina: 1, total_paginas: 1 }),
      listarDiariosPorData: async () => ({ edicoes: [], total: 0, pagina: 1, total_paginas: 1, filtro: {} }),
      listarDiariosPorSecao: async () => ({ edicoes: [], total: 0, pagina: 1, total_paginas: 1, filtro: {} }),
      extrairTextoModoLeitura: async () => '',
      extrairTextoPdfPaginasSeguro: async () => ({ total_paginas: 1, paginas: [''] }),
      ...overrides,
    },
    initializedSessions: new Map(),
  };
}

test('listTools pagina e expõe cursor', () => {
  const first = listTools();
  assert.ok(Array.isArray(first.tools));
  assert.ok(first.tools.length > 0);
  if (first.nextCursor) {
    const second = listTools(first.nextCursor);
    assert.ok(Array.isArray(second.tools));
  }
});

test('callTool retorna erro para tool desconhecida', async () => {
  const state = makeState();
  const result = await callTool(state, 'tool_inexistente', {});
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.ok, false);
});

test('callTool bloqueia analise_* por contrato tools-only', async () => {
  const state = makeState();
  const result = await callTool(state, 'analise_despesas', { exercicio: '2026' });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.ok, false);
  assert.match(result.structuredContent.message, /tools-only/i);
});

test('valida parâmetros obrigatórios antes de chamar endpoint', async () => {
  const state = makeState({
    request: async () => {
      throw new Error('nao deveria chamar endpoint');
    },
  });

  const result = await callTool(state, 'despesas_por_fornecedor', { Exercicio: '2026', Empresa: '1' });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.ok, false);
  assert.ok(Array.isArray(result.structuredContent.missing_required));
  assert.ok(result.structuredContent.missing_required.includes('DiaInicioPeriodo'));
});

test('injeta Empresa padrão e abre sessão automaticamente', async () => {
  const calls = [];
  const state = makeState({
    request: async (path, params) => {
      calls.push({ path, params: { ...params } });
      return [];
    },
  });

  const result = await callTool(state, 'despesas_detalhe_empenho', {
    intNumeroEmpenho: '123',
    strTipoEmpenho: 'OR',
  });

  assert.equal(result.isError, undefined);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].params.Listagem, 'DefineExercicio');
  assert.equal(calls[1].params.Empresa, '1');
});

test('consultar_diario_oficial processa múltiplos lotes e conclui scan', async () => {
  const offsets = [];
  const state = makeState({
    buscarDiarioPorTermo: async (_termo, _di, _df, _fonte, options) => {
      const offset = Number(options?.offset || 0);
      offsets.push(offset);
      if (offset === 0) {
        return {
          termo: 'Carlos',
          fonte: 'pdf',
          total_candidatos: 20,
          documentos_processados: 8,
          scan_completo: false,
          proximo_offset: 8,
          total_documentos_com_match: 1,
          total_documentos_indexados: 8,
          total_matches: 1,
          matches: [{ documento: { id_do: '1' }, trecho: 'Carlos Daniel' }],
          falhas: [],
        };
      }
      return {
        termo: 'Carlos',
        fonte: 'pdf',
        total_candidatos: 20,
        documentos_processados: 4,
        scan_completo: true,
        proximo_offset: undefined,
        total_documentos_com_match: 2,
        total_documentos_indexados: 12,
        total_matches: 2,
        matches: [
          { documento: { id_do: '1' }, trecho: 'Carlos Daniel' },
          { documento: { id_do: '2' }, trecho: 'Viana Ferrer' },
        ],
        falhas: [],
      };
    },
  });

  const result = await callTool(state, 'consultar_diario_oficial', { termo: 'Carlos' });
  const payload = result.structuredContent;

  assert.equal(payload.ok, true);
  assert.equal(payload.meta.scan_completo, true);
  assert.equal(payload.meta.is_partial, false);
  assert.ok(payload.meta.lotes_executados >= 2);
  assert.equal(payload.matches.length, 2);
  assert.deepEqual(offsets, [0, 8]);
});

test('buscar_no_diario retorna cursor quando scan fica parcial', async () => {
  const state = makeState({
    buscarDiarioPorTermo: async (_termo, _di, _df, _fonte, options) => {
      const offset = Number(options?.offset || 0);
      return {
        termo: 'x',
        fonte: 'pdf',
        total_candidatos: 500,
        documentos_processados: 8,
        scan_completo: false,
        proximo_offset: offset + 8,
        total_documentos_com_match: 0,
        total_documentos_indexados: offset + 8,
        total_matches: 0,
        matches: [],
        falhas: [],
      };
    },
  });

  const result = await callTool(state, 'buscar_no_diario', { termo: 'teste' });
  const payload = result.structuredContent;

  assert.equal(payload.ok, true);
  assert.equal(payload.meta.scan_completo, false);
  assert.equal(payload.meta.is_partial, true);
  assert.ok(typeof payload.meta.next_cursor === 'string' && payload.meta.next_cursor.length > 0);
  const decoded = JSON.parse(Buffer.from(payload.meta.next_cursor, 'base64').toString('utf-8'));
  assert.ok(Number(decoded.scan_offset) > 0);
});
