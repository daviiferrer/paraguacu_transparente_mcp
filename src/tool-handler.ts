import { FiorilliApiClient } from './api-client.js';
import { ALL_TOOLS, ToolDef } from './tools.js';
import {
  ALLOW_CONFIG_UPDATE,
  DEFAULT_PAGE_SIZE,
  DEFAULT_TEXT_BLOCK_CHARS,
  DIARIO_SCAN_BATCH_SIZE,
  DIARIO_SCAN_MAX_BATCHES,
  DIARIO_SCAN_TIME_BUDGET_MS,
  MAX_PAGE_SIZE,
  MAX_TEXT_PREVIEW,
  SessionState,
  TOOLS_LIST_PAGE_SIZE,
  clampInt,
  ensureSession,
} from './runtime.js';

type ControlArgs = {
  page: number;
  pageSize: number;
  search: string;
  fields: string[];
  orderBy: string;
  order: 'asc' | 'desc';
};

type ValidationIssue = {
  param: string;
  value: string;
  reason: string;
};

const CONFIGURAR_TOOL = {
  name: 'configurar_portal',
  description: '[Configuracao] Exibe configuracao atual; altera apenas se MCP_ALLOW_CONFIG_UPDATE=true.',
  inputSchema: {
    type: 'object',
    properties: {
      baseUrl: { type: 'string', description: 'URL base do portal Fiorilli.' },
      empresa: { type: 'string', description: 'ID da entidade (1=Prefeitura).' },
      exercicio: { type: 'string', description: 'Ano fiscal padrao.' },
    },
    required: [],
  },
  outputSchema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      config: { type: 'object' },
      allow_config_update: { type: 'boolean' },
      updated: { type: 'boolean' },
    },
    required: ['ok', 'config', 'allow_config_update', 'updated'],
  },
};

const LISTAR_CATEGORIAS_TOOL = {
  name: 'listar_categorias',
  description: '[Ajuda] Lista categorias e tools com paginacao.',
  inputSchema: {
    type: 'object',
    properties: {
      categoria: { type: 'string', description: 'Filtro opcional por categoria.' },
      busca: { type: 'string', description: 'Filtro por texto em nome/descricao.' },
      pagina: { type: 'number', description: 'Pagina (1-indexed).' },
      por_pagina: { type: 'number', description: 'Itens por pagina.' },
    },
    required: [],
  },
  outputSchema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      total: { type: 'number' },
      pagina: { type: 'number' },
      total_paginas: { type: 'number' },
      itens: { type: 'array' },
    },
    required: ['ok', 'total', 'pagina', 'total_paginas', 'itens'],
  },
};

const EXPOSED_TOOLS = [CONFIGURAR_TOOL, LISTAR_CATEGORIAS_TOOL, ...ALL_TOOLS.map(toMcpTool)];
const TOOL_INDEX = new Map<string, ToolDef>(ALL_TOOLS.map((tool) => [tool.name, tool]));

function asString(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

function toCursor(page: number): string {
  return Buffer.from(JSON.stringify({ page }), 'utf-8').toString('base64');
}

function fromCursor(cursor?: string): number | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64').toString('utf-8'));
    if (typeof parsed?.page === 'number' && parsed.page >= 1) {
      return Math.floor(parsed.page);
    }
  } catch {
    return null;
  }
  return null;
}

function decodeCursorObject(cursor?: string): Record<string, unknown> | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64').toString('utf-8'));
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function encodeCursorObject(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), 'utf-8').toString('base64');
}

function parseIntStrict(value: string): number | null {
  const raw = String(value || '').trim();
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function parseDateStrict(rawValue: string): Date | null {
  const raw = String(rawValue || '').trim();
  if (!raw) return null;

  const br = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (br) {
    const [, dd, mm, yyyy] = br;
    const day = Number(dd);
    const month = Number(mm);
    const year = Number(yyyy);
    const date = new Date(year, month - 1, day);
    if (
      date.getFullYear() !== year ||
      date.getMonth() !== month - 1 ||
      date.getDate() !== day
    ) {
      return null;
    }
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const [, yyyy, mm, dd] = iso;
    const day = Number(dd);
    const month = Number(mm);
    const year = Number(yyyy);
    const date = new Date(year, month - 1, day);
    if (
      date.getFullYear() !== year ||
      date.getMonth() !== month - 1 ||
      date.getDate() !== day
    ) {
      return null;
    }
    return Number.isNaN(date.getTime()) ? null : date;
  }

  return null;
}

function parseDateDotStrict(rawValue: string): Date | null {
  const raw = String(rawValue || '').trim();
  if (!raw) return null;

  const brDot = raw.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!brDot) return null;

  const [, dd, mm, yyyy] = brDot;
  const day = Number(dd);
  const month = Number(mm);
  const year = Number(yyyy);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return Number.isNaN(date.getTime()) ? null : date;
}

function validateDateRange(args: Record<string, unknown>, required: boolean): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const dataInicial = asString(args.dataInicial).trim();
  const dataFinal = asString(args.dataFinal).trim();

  if (required && !dataInicial) {
    issues.push({
      param: 'dataInicial',
      value: dataInicial,
      reason: 'obrigatorio para esta tool.',
    });
  }
  if (required && !dataFinal) {
    issues.push({
      param: 'dataFinal',
      value: dataFinal,
      reason: 'obrigatorio para esta tool.',
    });
  }
  if (dataInicial && !parseDateStrict(dataInicial)) {
    issues.push({
      param: 'dataInicial',
      value: dataInicial,
      reason: 'data invalida. Use DD/MM/AAAA ou YYYY-MM-DD com data real de calendario.',
    });
  }
  if (dataFinal && !parseDateStrict(dataFinal)) {
    issues.push({
      param: 'dataFinal',
      value: dataFinal,
      reason: 'data invalida. Use DD/MM/AAAA ou YYYY-MM-DD com data real de calendario.',
    });
  }

  const inicio = parseDateStrict(dataInicial);
  const fim = parseDateStrict(dataFinal);
  if (inicio && fim && inicio > fim) {
    issues.push({
      param: 'dataInicial',
      value: dataInicial,
      reason: 'nao pode ser maior que dataFinal.',
    });
  }

  return issues;
}

function validateQueryParams(queryParams: Record<string, string>, listagem?: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const monthFields = ['MesInicialPeriodo', 'MesFinalPeriodo'];
  const yearFields = ['Exercicio', 'ConectarExercicio'];
  const isExigibilidade = listagem === 'DespesasporExigibilidade';

  for (const field of monthFields) {
    if (!(field in queryParams)) continue;
    const value = queryParams[field];
    const parsed = parseIntStrict(value);
    if (parsed === null || parsed < 1 || parsed > 12) {
      issues.push({
        param: field,
        value,
        reason: 'deve ser inteiro entre 1 e 12.',
      });
    }
  }

  if (isExigibilidade) {
    const inicio = String(queryParams.DiaInicioPeriodo || '').trim();
    const fim = String(queryParams.DiaFinalPeriodo || '').trim();
    if (inicio && !parseDateDotStrict(inicio)) {
      issues.push({
        param: 'DiaInicioPeriodo',
        value: inicio,
        reason: 'deve estar no formato DD.MM.AAAA com data real de calendario.',
      });
    }
    if (fim && !parseDateDotStrict(fim)) {
      issues.push({
        param: 'DiaFinalPeriodo',
        value: fim,
        reason: 'deve estar no formato DD.MM.AAAA com data real de calendario.',
      });
    }
    const inicioDate = parseDateDotStrict(inicio);
    const fimDate = parseDateDotStrict(fim);
    if (inicioDate && fimDate && inicioDate > fimDate) {
      issues.push({
        param: 'DiaInicioPeriodo',
        value: inicio,
        reason: 'nao pode ser maior que DiaFinalPeriodo.',
      });
    }
  } else {
    const dayFields = ['DiaInicioPeriodo', 'DiaFinalPeriodo'];
    for (const field of dayFields) {
      if (!(field in queryParams)) continue;
      const value = queryParams[field];
      const parsed = parseIntStrict(value);
      if (parsed === null || parsed < 1 || parsed > 31) {
        issues.push({
          param: field,
          value,
          reason: 'deve ser inteiro entre 1 e 31.',
        });
      }
    }
  }

  for (const field of yearFields) {
    if (!(field in queryParams)) continue;
    const value = queryParams[field];
    const parsed = parseIntStrict(value);
    if (parsed === null || String(value).trim().length !== 4 || parsed < 1900 || parsed > 9999) {
      issues.push({
        param: field,
        value,
        reason: 'deve ter 4 digitos numericos (ex: 2026).',
      });
    }
  }

  const mesInicio = parseIntStrict(queryParams.MesInicialPeriodo || '');
  const mesFinal = parseIntStrict(queryParams.MesFinalPeriodo || '');
  const diaInicio = parseIntStrict(queryParams.DiaInicioPeriodo || '');
  const diaFinal = parseIntStrict(queryParams.DiaFinalPeriodo || '');
  if (mesInicio !== null && mesFinal !== null) {
    if (mesInicio > mesFinal) {
      issues.push({
        param: 'MesInicialPeriodo',
        value: String(mesInicio),
        reason: 'nao pode ser maior que MesFinalPeriodo para o mesmo exercicio.',
      });
    } else if (mesInicio === mesFinal && diaInicio !== null && diaFinal !== null && diaInicio > diaFinal) {
      issues.push({
        param: 'DiaInicioPeriodo',
        value: String(diaInicio),
        reason: 'nao pode ser maior que DiaFinalPeriodo quando o mes inicial e final sao iguais.',
      });
    }
  }

  return issues;
}

function parseControlArgs(args: Record<string, unknown> | undefined): ControlArgs {
  const cursorPage = fromCursor(asString(args?._cursor));
  return {
    page: cursorPage ?? clampInt(args?._pagina, 1, 1, 1000000),
    pageSize: clampInt(args?._por_pagina, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE),
    search: asString(args?._busca).trim(),
    fields: asString(args?._campos).split(',').map((value) => value.trim()).filter(Boolean),
    orderBy: asString(args?._ordenar_por).trim(),
    order: asString(args?._ordem).toLowerCase() === 'asc' ? 'asc' : 'desc',
  };
}

function normalizeList<T>(rows: T[], control: ControlArgs): {
  rows: T[];
  total: number;
  totalPages: number;
  page: number;
  hasNext: boolean;
  nextCursor?: string;
} {
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / control.pageSize));
  const page = Math.min(control.page, totalPages);
  const start = (page - 1) * control.pageSize;
  const end = start + control.pageSize;
  const paged = rows.slice(start, end);
  const hasNext = page < totalPages;
  return {
    rows: paged,
    total,
    totalPages,
    page,
    hasNext,
    nextCursor: hasNext ? toCursor(page + 1) : undefined,
  };
}

function summarizeText(text: string): string {
  if (text.length <= MAX_TEXT_PREVIEW) return text;
  return `${text.slice(0, MAX_TEXT_PREVIEW)}\n...[texto resumido no campo content; JSON completo em structuredContent]`;
}

function compareValues(a: unknown, b: unknown, order: 'asc' | 'desc'): number {
  const na = Number(String(a).replace(',', '.'));
  const nb = Number(String(b).replace(',', '.'));
  let result: number;
  if (Number.isFinite(na) && Number.isFinite(nb)) result = na - nb;
  else result = String(a ?? '').localeCompare(String(b ?? ''), 'pt-BR', { sensitivity: 'base' });
  return order === 'asc' ? result : -result;
}

function projectFields(row: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) out[field] = row?.[field];
  return out;
}

function chunkText(text: string, size: number): string[] {
  if (!text) return [''];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    out.push(text.slice(i, i + size));
  }
  return out.length > 0 ? out : [''];
}

function filterTextByKeyword(text: string, keyword: string): string {
  const needle = keyword.toLowerCase();
  if (!needle) return text;

  const lower = text.toLowerCase();
  const snippets: string[] = [];
  let idx = lower.indexOf(needle);
  while (idx !== -1 && snippets.length < 100) {
    const start = Math.max(0, idx - 250);
    const end = Math.min(text.length, idx + needle.length + 250);
    snippets.push(text.slice(start, end));
    idx = lower.indexOf(needle, idx + needle.length);
  }

  if (snippets.length === 0) return '';
  return snippets.join('\n\n---\n\n');
}

async function extractPdfText(state: SessionState, url: string): Promise<string> {
  if (!url) throw new Error('Parametro "url_pdf" e obrigatorio.');
  const parsed = await state.apiClient.extrairTextoPdfPaginasSeguro(url);
  return parsed.paginas.join('\n\n');
}

function toMcpTool(def: ToolDef) {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const param of def.params) {
    properties[param.name] = {
      type: param.type === 'number' ? 'number' : 'string',
      description: param.description,
    };
    if (param.required) required.push(param.name);
  }

  properties._pagina = { type: 'number', description: 'Pagina para saida paginada (1-indexed).' };
  properties._por_pagina = { type: 'number', description: 'Itens por pagina (ou tamanho de bloco para texto).' };
  properties._cursor = { type: 'string', description: 'Cursor retornado pela resposta anterior.' };
  properties._busca = { type: 'string', description: 'Filtro textual case-insensitive sobre os dados.' };
  properties._campos = { type: 'string', description: 'Campos separados por virgula para projecao.' };
  properties._ordenar_por = { type: 'string', description: 'Campo para ordenacao local.' };
  properties._ordem = { type: 'string', description: 'Ordem: asc ou desc (padrao desc).' };

  return {
    name: def.name,
    description: `[${def.category}] ${def.description}`,
    inputSchema: { type: 'object', properties, required },
    outputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        tool: { type: 'string' },
        meta: { type: 'object' },
        data: { type: 'array' },
      },
      required: ['ok', 'tool'],
    },
  };
}

export function listTools(cursor?: string): { tools: unknown[]; nextCursor?: string } {
  const startPage = fromCursor(cursor) ?? 1;
  const startIndex = (startPage - 1) * TOOLS_LIST_PAGE_SIZE;
  const tools = EXPOSED_TOOLS.slice(startIndex, startIndex + TOOLS_LIST_PAGE_SIZE);
  const hasNext = startIndex + TOOLS_LIST_PAGE_SIZE < EXPOSED_TOOLS.length;
  return {
    tools,
    nextCursor: hasNext ? toCursor(startPage + 1) : undefined,
  };
}

export async function callTool(state: SessionState, name: string, args: Record<string, unknown>) {
  const control = parseControlArgs(args);

  if (name.startsWith('analise_')) {
    const payload = {
      ok: false,
      tool: name,
      message: 'Tools analise_* foram removidas deste servidor MCP (tools-only). Consuma tools brutas e execute a logica de analise no cliente.',
    };
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structuredContent: payload, isError: true };
  }

  if (name === 'configurar_portal') {
    const incoming = {
      baseUrl: asString(args.baseUrl).replace(/\/+$/, ''),
      empresa: asString(args.empresa),
      exercicio: asString(args.exercicio),
    };
    let updated = false;

    if ((incoming.baseUrl || incoming.empresa || incoming.exercicio) && !ALLOW_CONFIG_UPDATE) {
      const payload = {
        ok: false,
        allow_config_update: false,
        updated: false,
        config: state.config,
        message: 'Atualizacao desabilitada. Defina MCP_ALLOW_CONFIG_UPDATE=true para habilitar.',
      };
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structuredContent: payload, isError: true };
    }

    if (ALLOW_CONFIG_UPDATE) {
      if (incoming.baseUrl && incoming.baseUrl !== state.config.baseUrl) {
        state.config.baseUrl = incoming.baseUrl;
        state.apiClient = new FiorilliApiClient(state.config.baseUrl);
        state.initializedSessions.clear();
        updated = true;
      }
      if (incoming.empresa && incoming.empresa !== state.config.empresa) {
        state.config.empresa = incoming.empresa;
        updated = true;
      }
      if (incoming.exercicio && incoming.exercicio !== state.config.exercicio) {
        state.config.exercicio = incoming.exercicio;
        state.initializedSessions.clear();
        updated = true;
      }
    }

    const payload = { ok: true, allow_config_update: ALLOW_CONFIG_UPDATE, updated, config: state.config };
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
  }

  if (name === 'listar_categorias') {
    const busca = asString(args.busca).toLowerCase();
    const categoria = asString(args.categoria);
    let rows = ALL_TOOLS.map((tool) => ({ nome: tool.name, categoria: tool.category, descricao: tool.description }));
    if (categoria) rows = rows.filter((row) => row.categoria.toLowerCase() === categoria.toLowerCase());
    if (busca) rows = rows.filter((row) => `${row.nome} ${row.descricao}`.toLowerCase().includes(busca));

    const paged = normalizeList(rows, {
      ...control,
      page: clampInt(args.pagina, control.page, 1, 1000000),
      pageSize: clampInt(args.por_pagina, control.pageSize, 1, MAX_PAGE_SIZE),
    });

    const payload = {
      ok: true,
      total: paged.total,
      pagina: paged.page,
      total_paginas: paged.totalPages,
      has_next: paged.hasNext,
      next_cursor: paged.nextCursor,
      itens: paged.rows,
    };
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
  }

  if (name === 'consultar_diario_oficial' || name === 'buscar_no_diario') {
    const termo = asString(args.termo).trim();
    if (!termo) {
      const payload = { ok: false, tool: name, message: 'Parametro "termo" e obrigatorio.' };
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structuredContent: payload, isError: true };
    }

    const dateIssues = validateDateRange(args, false);
    if (dateIssues.length > 0) {
      const payload = {
        ok: false,
        tool: name,
        message: 'Parametros de data invalidos.',
        invalid_params: dateIssues,
      };
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structuredContent: payload, isError: true };
    }

    const scanCursor = decodeCursorObject(asString(args._cursor));
    const startedAt = Date.now();
    const deadline = startedAt + DIARIO_SCAN_TIME_BUDGET_MS;
    let scanOffset = Math.max(0, Number(scanCursor?.scan_offset) || 0);
    let resultOffset = Math.max(
      0,
      Number(scanCursor?.result_offset)
      || ((control.page > 1 ? control.page - 1 : 0) * control.pageSize),
    );
    let nextScanOffset = scanOffset;
    let scanComplete = false;
    let lotesExecutados = 0;
    let limiteLotesAtingido = false;
    let limiteTempoAtingido = false;
    let totalCandidates = 0;
    let totalIndexed = 0;
    let processedDocs = 0;
    let documentosComMatch = 0;
    let rows: Record<string, unknown>[] = [];
    const falhas: Record<string, unknown>[] = [];

    for (let batch = 0; batch < DIARIO_SCAN_MAX_BATCHES; batch += 1) {
      if (Date.now() >= deadline) {
        limiteTempoAtingido = true;
        break;
      }

      const searchResult = await state.apiClient.buscarDiarioPorTermo(
        termo,
        asString(args.dataInicial),
        asString(args.dataFinal),
        'pdf',
        {
          offset: scanOffset,
          limit: DIARIO_SCAN_BATCH_SIZE,
        },
      );

      lotesExecutados += 1;
      totalCandidates = searchResult.total_candidatos;
      totalIndexed = searchResult.total_documentos_indexados;
      documentosComMatch = searchResult.total_documentos_com_match;
      processedDocs += searchResult.documentos_processados;
      rows = searchResult.matches as unknown as Record<string, unknown>[];
      falhas.push(...(searchResult.falhas as unknown as Record<string, unknown>[]));

      const proximoOffset = typeof searchResult.proximo_offset === 'number'
        ? Math.max(0, searchResult.proximo_offset)
        : undefined;
      scanComplete = searchResult.scan_completo || searchResult.documentos_processados === 0;
      if (scanComplete) {
        break;
      }

      if (proximoOffset === undefined || proximoOffset <= scanOffset) {
        scanComplete = true;
        break;
      }

      nextScanOffset = proximoOffset;
      scanOffset = proximoOffset;
    }

    if (!scanComplete && !limiteTempoAtingido && lotesExecutados >= DIARIO_SCAN_MAX_BATCHES) {
      limiteLotesAtingido = true;
    }

    if (control.search) {
      const needle = control.search.toLowerCase();
      const filtered = rows.filter((row) => JSON.stringify(row).toLowerCase().includes(needle));
      rows.length = 0;
      rows.push(...filtered);
    }
    if (control.orderBy) {
      const field = control.orderBy;
      rows.sort((a, b) => compareValues(a?.[field], b?.[field], control.order));
    }

    const effectiveOffset = Math.max(0, resultOffset);
    const nextResultOffset = effectiveOffset + control.pageSize;
    const pagedRows = rows.slice(effectiveOffset, nextResultOffset);
    const hasMoreRows = nextResultOffset < rows.length;
    const currentPage = Math.floor(effectiveOffset / control.pageSize) + 1;
    const hasNext = !scanComplete || hasMoreRows;
    const nextCursor = hasNext
      ? encodeCursorObject({
          scan_offset: scanComplete ? nextScanOffset : nextScanOffset,
          result_offset: nextResultOffset,
        })
      : undefined;
    const payload = {
      ok: true,
      tool: name,
      meta: {
        termo,
        fonte_principal: 'pdf',
        pagina: currentPage,
        por_pagina: control.pageSize,
        lotes_executados: lotesExecutados,
        documentos_processados_no_lote: processedDocs,
        scan_offset_atual: Math.max(0, Number(scanCursor?.scan_offset) || 0),
        result_offset_atual: effectiveOffset,
        scan_completo: scanComplete,
        is_partial: !scanComplete,
        scan_tempo_ms: Date.now() - startedAt,
        scan_limite_lotes_atingido: limiteLotesAtingido,
        scan_limite_tempo_atingido: limiteTempoAtingido,
        total_matches: rows.length,
        total_paginas: scanComplete ? Math.max(1, Math.ceil(rows.length / control.pageSize)) : undefined,
        has_next: hasNext,
        next_cursor: nextCursor,
        total_documentos_candidatos: totalCandidates,
        total_documentos_indexados: totalIndexed,
        total_documentos_com_match: documentosComMatch,
        falhas: falhas.length,
        filtros: {
          data_inicial: asString(args.dataInicial) || null,
          data_final: asString(args.dataFinal) || null,
        },
      },
      matches: pagedRows,
      falhas,
    };
    return {
      content: [{ type: 'text', text: summarizeText(JSON.stringify(payload, null, 2)) }],
      structuredContent: payload,
    };
  }

  if (
    name === 'listar_diarios' ||
    name === 'listar_diarios_por_data' ||
    name === 'listar_diarios_por_secao' ||
    name === 'listar_secoes_diario'
  ) {
    try {
      let payload: Record<string, unknown>;
      if (name === 'listar_diarios') {
        const pagina = clampInt(args.pagina, control.page, 1, 1000000);
        const porPagina = clampInt(args.por_pagina, control.pageSize, 1, 50);
        const diario = await state.apiClient.listarDiarios(pagina, porPagina);
        payload = {
          ok: true,
          tool: name,
          meta: {
            pagina: diario.pagina,
            por_pagina: porPagina,
            total_itens: diario.total,
            total_paginas: diario.total_paginas,
            has_next: diario.pagina < diario.total_paginas,
            next_cursor: diario.pagina < diario.total_paginas ? toCursor(diario.pagina + 1) : undefined,
          },
          data: diario.edicoes,
        };
      } else if (name === 'listar_diarios_por_data') {
        const dateIssues = validateDateRange(args, true);
        if (dateIssues.length > 0) {
          const errorPayload = {
            ok: false,
            tool: name,
            message: 'Parametros de data invalidos.',
            invalid_params: dateIssues,
          };
          return {
            content: [{ type: 'text', text: JSON.stringify(errorPayload, null, 2) }],
            structuredContent: errorPayload,
            isError: true,
          };
        }

        const pagina = clampInt(args.pagina, control.page, 1, 1000000);
        const porPagina = clampInt(args.por_pagina, control.pageSize, 1, 50);
        const diario = await state.apiClient.listarDiariosPorData(
          asString(args.dataInicial),
          asString(args.dataFinal),
          pagina,
          porPagina,
        );
        payload = {
          ok: true,
          tool: name,
          meta: {
            pagina: diario.pagina,
            por_pagina: porPagina,
            total_itens: diario.total,
            total_paginas: diario.total_paginas,
            has_next: diario.pagina < diario.total_paginas,
            next_cursor: diario.pagina < diario.total_paginas ? toCursor(diario.pagina + 1) : undefined,
            filtro: diario.filtro,
          },
          data: diario.edicoes,
        };
      } else if (name === 'listar_diarios_por_secao') {
        const pagina = clampInt(args.pagina, control.page, 1, 1000000);
        const porPagina = clampInt(args.por_pagina, control.pageSize, 1, 50);
        const diario = await state.apiClient.listarDiariosPorSecao(
          asString(args.id_secao),
          pagina,
          porPagina,
        );
        payload = {
          ok: true,
          tool: name,
          meta: {
            pagina: diario.pagina,
            por_pagina: porPagina,
            total_itens: diario.total,
            total_paginas: diario.total_paginas,
            has_next: diario.pagina < diario.total_paginas,
            next_cursor: diario.pagina < diario.total_paginas ? toCursor(diario.pagina + 1) : undefined,
            filtro: diario.filtro,
          },
          data: diario.edicoes,
        };
      } else {
        payload = {
          ok: true,
          tool: name,
          meta: {
            total_itens: Object.keys(FiorilliApiClient.SECOES_DIARIO).length,
          },
          data: Object.entries(FiorilliApiClient.SECOES_DIARIO).map(([id, nome]) => ({
            id_secao: id,
            nome,
          })),
        };
      }

      return {
        content: [{ type: 'text', text: summarizeText(JSON.stringify(payload, null, 2)) }],
        structuredContent: payload,
      };
    } catch (err) {
      const payload = { ok: false, tool: name, message: err instanceof Error ? err.message : String(err) };
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
        isError: true,
      };
    }
  }

  const def = TOOL_INDEX.get(name);
  if (!def) {
    const payload = { ok: false, tool: name, message: 'Ferramenta nao encontrada.' };
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structuredContent: payload, isError: true };
  }

  try {
    if (name === 'extrair_texto_diario' || name === 'extrair_texto_modo_leitura') {
      const textoBruto = name === 'extrair_texto_diario'
        ? await extractPdfText(state, asString(args.url_pdf))
        : await state.apiClient.extrairTextoModoLeitura(asString(args.url_modo_texto));

      const textControlSize = clampInt(args._por_pagina, DEFAULT_TEXT_BLOCK_CHARS, 50, 100000);
      const term = control.search;
      const baseText = term ? filterTextByKeyword(textoBruto, term) : textoBruto;
      const blocks = chunkText(baseText, textControlSize);
      const page = clampInt(args._pagina, control.page, 1, Math.max(1, blocks.length));
      const index = Math.min(blocks.length - 1, page - 1);
      const payload = {
        ok: true,
        tool: name,
        meta: {
          total_chars: textoBruto.length,
          filtro_busca: term || null,
          pagina: page,
          por_pagina: textControlSize,
          total_paginas: Math.max(1, blocks.length),
          has_next: page < blocks.length,
          next_cursor: page < blocks.length ? toCursor(page + 1) : undefined,
        },
        texto: blocks[index] || '',
      };
      return {
        content: [{ type: 'text', text: summarizeText(JSON.stringify(payload, null, 2)) }],
        structuredContent: payload,
      };
    }

    let exercicioUsado = state.config.exercicio;
    const queryParams: Record<string, string> = { Listagem: def.listagem };
    const missingRequired: string[] = [];

    for (const param of def.params) {
      const value = args[param.name];
      const isMissing = value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
      if (!isMissing) {
        queryParams[param.name] = typeof value === 'string' ? value.trim() : String(value);
        if (param.name === 'Exercicio' || param.name === 'ConectarExercicio') exercicioUsado = queryParams[param.name];
        continue;
      }
      if (param.required) {
        if (param.name === 'Empresa') queryParams[param.name] = state.config.empresa;
        else if (param.name === 'Exercicio' || param.name === 'ConectarExercicio') {
          queryParams[param.name] = state.config.exercicio;
        } else {
          missingRequired.push(param.name);
        }
      } else if (param.name === 'MostraDadosConsolidado') {
        queryParams[param.name] = 'False';
      }
    }

    if (def.listagem === 'DespesasporExigibilidade') {
      const idx = missingRequired.indexOf('strTipoLista');
      if (idx !== -1) missingRequired.splice(idx, 1);
    }

    if (
      def.listagem === 'EmpenhosDespesas_Empenhado_PorNumeroEmpenho' ||
      def.listagem === 'EmpenhosDespesas_Liquidado_PorNumeroEmpenho' ||
      def.listagem === 'EmpenhosDespesas_Pago_PorNumeroEmpenho'
    ) {
      queryParams.IDButton = queryParams.IDButton || 'lnkDespesasPor_NotaEmpenho';
    }

    if (def.listagem === 'DespesasporExigibilidade') {
      queryParams.strTipoLista = queryParams.strTipoLista || '1';
    }

    const validationIssues = validateQueryParams(queryParams, def.listagem);
    if (validationIssues.length > 0) {
      const payload = {
        ok: false,
        tool: name,
        message: 'Parametros invalidos para a consulta.',
        invalid_params: validationIssues,
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
        isError: true,
      };
    }

    if (missingRequired.length > 0) {
      const payload = {
        ok: false,
        tool: name,
        message: `Parametros obrigatorios ausentes: ${missingRequired.join(', ')}`,
        missing_required: missingRequired,
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
        isError: true,
      };
    }

    if (def.listagem !== 'DefineExercicio') {
      await ensureSession(state, def.category, exercicioUsado);
    }

    const raw = await state.apiClient.request(def.path, queryParams);

    if (!Array.isArray(raw)) {
      const payload = { ok: true, tool: name, meta: { category: def.category }, data: raw };
      return { content: [{ type: 'text', text: summarizeText(JSON.stringify(payload, null, 2)) }], structuredContent: payload };
    }

    let rows = raw.slice() as Record<string, unknown>[];
    if (control.search) {
      const needle = control.search.toLowerCase();
      rows = rows.filter((row) => JSON.stringify(row).toLowerCase().includes(needle));
    }
    if (control.orderBy) {
      const field = control.orderBy;
      rows.sort((a, b) => compareValues(a?.[field], b?.[field], control.order));
    }
    if (control.fields.length > 0) {
      rows = rows.map((row) => projectFields(row, control.fields));
    }

    const paged = normalizeList(rows, control);
    const payload = {
      ok: true,
      tool: name,
      meta: {
        category: def.category,
        source: state.config.baseUrl,
        listagem: def.listagem,
        pagina: paged.page,
        por_pagina: control.pageSize,
        total_itens: paged.total,
        total_paginas: paged.totalPages,
        has_next: paged.hasNext,
        next_cursor: paged.nextCursor,
        filtros: {
          busca: control.search || null,
          campos: control.fields,
          ordenar_por: control.orderBy || null,
          ordem: control.order,
        },
      },
      data: paged.rows,
    };
    return {
      content: [{ type: 'text', text: summarizeText(JSON.stringify(payload, null, 2)) }],
      structuredContent: payload,
    };
  } catch (err) {
    const payload = { ok: false, tool: name, message: err instanceof Error ? err.message : String(err) };
    return {
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
      isError: true,
    };
  }
}
