import { FiorilliApiClient } from './api-client.js';

export type RuntimeConfig = {
  baseUrl: string;
  empresa: string;
  exercicio: string;
};

export type SessionState = {
  config: RuntimeConfig;
  apiClient: FiorilliApiClient;
  initializedSessions: Map<string, string>;
};

export const DEFAULT_BASE_URL = 'http://sistemas2.eparaguacu.sp.gov.br:8079/transparencia';
export const DEFAULT_EMPRESA = '1';
export const DEFAULT_EXERCICIO = new Date().getFullYear().toString();

export const DEFAULT_PAGE_SIZE = clampInt(process.env.MCP_DEFAULT_PAGE_SIZE, 100, 1, 1000);
export const MAX_PAGE_SIZE = clampInt(process.env.MCP_MAX_PAGE_SIZE, 500, 1, 5000);
export const DEFAULT_TEXT_BLOCK_CHARS = clampInt(process.env.MCP_TEXT_BLOCK_CHARS, 12000, 1000, 50000);
export const MAX_TEXT_PREVIEW = clampInt(process.env.MCP_MAX_TEXT_PREVIEW, 7000, 500, 30000);
export const TOOLS_LIST_PAGE_SIZE = clampInt(process.env.MCP_TOOLS_LIST_PAGE_SIZE, 200, 20, 1000);
export const DIARIO_SCAN_BATCH_SIZE = clampInt(process.env.MCP_DIARIO_SCAN_BATCH_SIZE, 8, 1, 100);
export const DIARIO_SCAN_MAX_BATCHES = clampInt(process.env.MCP_DIARIO_SCAN_MAX_BATCHES, 2, 1, 50);
export const DIARIO_SCAN_TIME_BUDGET_MS = clampInt(process.env.MCP_DIARIO_SCAN_TIME_BUDGET_MS, 15000, 5000, 300000);
export const FIORILLI_MAX_RETRIES = clampInt(process.env.MCP_FIORILLI_MAX_RETRIES, 3, 1, 8);
export const DOSP_MAX_RETRIES = clampInt(process.env.MCP_DOSP_MAX_RETRIES, 3, 1, 8);
export const RETRY_BASE_DELAY_MS = clampInt(process.env.MCP_RETRY_BASE_DELAY_MS, 350, 50, 5000);

export const ALLOW_CONFIG_UPDATE = String(process.env.MCP_ALLOW_CONFIG_UPDATE || 'false').toLowerCase() === 'true';
export const TRANSPORT_MODE = String(process.env.MCP_TRANSPORT || 'stdio').toLowerCase();
export const HTTP_PORT = clampInt(process.env.PORT, 3000, 1, 65535);
export const HTTP_HOST = process.env.HOST || '0.0.0.0';
export const ALLOWED_HOSTS = (process.env.MCP_ALLOWED_HOSTS || '')
  .split(',')
  .map((host) => host.trim())
  .filter(Boolean);

const CATEGORY_PATHS_BY_NORMALIZED: Record<string, string> = {
  despesas: '/VersaoJson/Despesas/',
  receitas: '/VersaoJson/Receitas/',
  'licitacoes e contratos': '/VersaoJson/LicitacoesEContratos/',
  transferencias: '/VersaoJson/Transferencias/',
  pessoal: '/VersaoJson/Pessoal/',
};

function normalizeKey(value: string): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

export function createInitialState(): SessionState {
  const config: RuntimeConfig = {
    baseUrl: DEFAULT_BASE_URL.replace(/\/+$/, ''),
    empresa: DEFAULT_EMPRESA,
    exercicio: DEFAULT_EXERCICIO,
  };
  return {
    config,
    apiClient: new FiorilliApiClient(config.baseUrl),
    initializedSessions: new Map<string, string>(),
  };
}

export async function ensureSession(state: SessionState, category: string, exercicio: string): Promise<void> {
  if (state.initializedSessions.get(category) === exercicio) return;
  const path = CATEGORY_PATHS_BY_NORMALIZED[normalizeKey(category)];
  if (!path) return;
  try {
    await state.apiClient.request(path, {
      Listagem: 'DefineExercicio',
      ConectarExercicio: exercicio,
    });
    state.initializedSessions.set(category, exercicio);
  } catch (err) {
    process.stderr.write(`Sessao nao inicializada (${category}/${exercicio}): ${String(err)}\n`);
  }
}
