/**
 * Cliente HTTP para a API JSON do Portal de Transparência Fiorilli.
 * Constrói URLs a partir das definições de ferramentas e faz requisições GET.
 * Trata erros do ASP.NET (páginas HTML de erro) de forma graciosa.
 *
 * IMPORTANTE: A API Fiorilli é session-based via cookies ASP.NET.
 * O DefineExercicio cria uma sessão no servidor, e os cookies devem
 * ser mantidos entre requisições para que os dados sejam retornados
 * corretamente (caso contrário, EMPENHADO/LIQUIDADO/PAGO vêm zerados).
 */

import fetch, { Response } from 'node-fetch';
import { extractText } from 'unpdf';
import { DiarioIndex } from './diario-index.js';

export interface PdfTextExtraction {
  total_paginas: number;
  paginas: string[];
}

export interface DiarioBuscaSnippet {
  documento: {
    id_do: string;
    data: string;
    data_iso: string;
    edicao_num: string;
    edicao_ano: string;
    paginas: number;
    flag_extra: boolean;
    url_original_eletronico: string;
    url_modo_texto: string;
    url_pdf_direto: string;
  };
  termo: string;
  fonte: 'pdf';
  pagina?: number;
  ocorrencias_na_pagina?: number;
  trecho: string;
}

type HiddenInputs = Record<string, string>;

type DespesasGeraisPage = {
  rows: Record<string, string>[];
  summary: {
    pagina_atual: number;
    total_paginas: number;
    total_linhas: number;
  };
  totals: Record<string, string>;
  hiddenInputs: HiddenInputs;
  callbackState?: string;
};

type CacheEntry<T> = {
  expiresAt: number;
  value: T;
};

export class FiorilliApiClient {
  private baseUrl: string;
  private cookies: Map<string, string> = new Map();
  private pdfExtractionQueue: Promise<void> = Promise.resolve();
  private diarioListaCache = new Map<string, CacheEntry<any[]>>();
  private pdfPaginasCache = new Map<string, CacheEntry<PdfTextExtraction>>();
  private diarioIndex: DiarioIndex;
  private readonly DIARIO_LIST_TTL_MS = 10 * 60 * 1000;
  private readonly PDF_TEXT_TTL_MS = 60 * 60 * 1000;
  private readonly FIORILLI_MAX_RETRIES = this.parseIntEnv(process.env.MCP_FIORILLI_MAX_RETRIES, 3, 1, 8);
  private readonly DOSP_MAX_RETRIES = this.parseIntEnv(process.env.MCP_DOSP_MAX_RETRIES, 3, 1, 8);
  private readonly RETRY_BASE_DELAY_MS = this.parseIntEnv(process.env.MCP_RETRY_BASE_DELAY_MS, 350, 50, 5000);

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    this.diarioIndex = new DiarioIndex();
  }

  private parseIntEnv(value: unknown, fallback: number, min: number, max: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(parsed)));
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private shouldRetryStatus(status: number): boolean {
    return status === 408 || status === 429 || status >= 500;
  }

  private async backoff(attempt: number): Promise<void> {
    const jitter = Math.floor(Math.random() * 120);
    const delay = this.RETRY_BASE_DELAY_MS * attempt + jitter;
    await this.sleep(delay);
  }

  private async withPdfExtractionLock<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.pdfExtractionQueue;
    let release!: () => void;
    this.pdfExtractionQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }

  private getCachedValue<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
    const item = cache.get(key);
    if (!item) return null;
    if (Date.now() > item.expiresAt) {
      cache.delete(key);
      return null;
    }
    return item.value;
  }

  private setCachedValue<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T, ttlMs: number): T {
    cache.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    });
    return value;
  }

  /**
   * Extrai texto bruto de um PDF do Diário Oficial (DOSP)
   * Usa a biblioteca 'unpdf' para extração silenciosa e portável.
   *
   * IMPORTANTE: pdfjs-dist (usado pelo unpdf) imprime "Warning:" no stdout
   * via mecanismo interno, o que corrompe o protocolo MCP (stdio JSON-RPC).
   * Por isso, stdout.write é temporariamente bloqueado durante a extração,
   * redirecionando tudo para stderr.
   */
  async extrairTextoPdf(url: string): Promise<string> {
    return this.withPdfExtractionLock(async () => {
      // ── 1. Baixar o conteúdo da URL ──
      let res;
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 45000);
        res = await fetch(url, {
          signal: controller.signal as any,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
            'Accept': 'application/pdf,text/html,application/xhtml+xml,*/*;q=0.8',
            'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
            'Upgrade-Insecure-Requests': '1'
          }
        });
        clearTimeout(timeoutId);
      } catch (fetchErr) {
        const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
        throw new Error(`Falha ao baixar o PDF: ${msg}. URL: ${url}`);
      }

      if (!res.ok) {
        throw new Error(
          `Falha ao baixar o PDF: HTTP ${res.status} ${res.statusText}. ` +
          `URL: ${url}. O documento pode ter sido removido ou o ID pode estar inválido.`
        );
      }

      // ── 2. Validar Content-Type ──
      const contentType = res.headers.get('content-type') || '';

      // Se o Content-Type é claramente HTML/texto, o servidor PHP retornou
      // uma página de erro (ex: "Warning: ...") em vez do PDF.
      if (
        contentType.includes('text/html') ||
        contentType.includes('text/plain')
      ) {
        const body = await res.text();
        const preview = body.substring(0, 300).replace(/\n/g, ' ');
        throw new Error(
          `A URL não retornou um PDF. Content-Type: ${contentType}. ` +
          `O servidor retornou HTML/texto — o documento pode ter expirado ou o ID é inválido. ` +
          `Preview: ${preview}`
        );
      }

      // ── 3. Ler bytes e validar magic number %PDF ──
      const buffer = await res.arrayBuffer();
      const bytes = new Uint8Array(buffer);

      if (bytes.length < 5) {
        throw new Error(
          `Resposta muito curta (${bytes.length} bytes) — não é um PDF válido. ` +
          `URL: ${url}`
        );
      }

      // PDF magic number: %PDF (0x25 0x50 0x44 0x46)
      const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
      if (magic !== '%PDF') {
        // Tenta decodificar como texto para dar contexto no erro
        const decoder = new TextDecoder('utf-8', { fatal: false });
        const preview = decoder.decode(bytes.slice(0, 300)).replace(/\n/g, ' ');
        throw new Error(
          `O conteúdo retornado não é um PDF válido (magic bytes: "${magic}" em vez de "%PDF"). ` +
          `Content-Type: ${contentType}. ` +
          `O servidor provavelmente retornou uma página de erro HTML ou um Warning PHP. ` +
          `Preview: ${preview}`
        );
      }

      // ── 4. Extrair texto com proteção contra stdout pollution ──
      const realStdoutWrite = process.stdout.write;
      try {
        (process.stdout as any).write = function (chunk: any, ...args: any[]) {
          return (process.stderr as any).write(chunk, ...args);
        };

        const { text: rawText } = await extractText(bytes);
        const texto = Array.isArray(rawText) ? rawText.join('\n') : rawText;

        return texto || 'Nenhum texto extraído do PDF.';
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Falha durante análise do PDF (unpdf): ${msg}`);
      } finally {
        (process.stdout as any).write = realStdoutWrite;
      }
    });
  }

  /**
   * Extrai cookies do header Set-Cookie da resposta e armazena.
   */
  async extrairTextoPdfPaginas(url: string): Promise<PdfTextExtraction> {
    let res;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 45000);
      res = await fetch(url, {
        signal: controller.signal as any,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
          'Accept': 'application/pdf,text/html,application/xhtml+xml,*/*;q=0.8',
          'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
          'Upgrade-Insecure-Requests': '1'
        }
      });
      clearTimeout(timeoutId);
    } catch (fetchErr) {
      const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      throw new Error(`Falha ao baixar o PDF: ${msg}. URL: ${url}`);
    }

    if (!res.ok) {
      throw new Error(`Falha ao baixar o PDF: HTTP ${res.status} ${res.statusText}. URL: ${url}`);
    }

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('text/html') || contentType.includes('text/plain')) {
      const body = await res.text();
      const preview = body.substring(0, 300).replace(/\n/g, ' ');
      throw new Error(`A URL nÃ£o retornou PDF vÃ¡lido. Content-Type: ${contentType}. Preview: ${preview}`);
    }

    const bytes = new Uint8Array(await res.arrayBuffer());
    const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    if (magic !== '%PDF') {
      const preview = new TextDecoder('utf-8', { fatal: false })
        .decode(bytes.slice(0, 300))
        .replace(/\n/g, ' ');
      throw new Error(`ConteÃºdo retornado nÃ£o Ã© PDF vÃ¡lido. Preview: ${preview}`);
    }

    const realStdoutWrite = process.stdout.write;
    try {
      (process.stdout as any).write = function (chunk: any, ...args: any[]) {
        return (process.stderr as any).write(chunk, ...args);
      };

      const { text: rawText, totalPages } = await extractText(bytes, { mergePages: false });
      const paginas = Array.isArray(rawText) ? rawText : [String(rawText ?? '')];
      const normalizadas = paginas.map((pagina) => {
        const limpa = String(pagina || '').replace(/\s+\n/g, '\n').trim();
        return limpa || '[PÃ¡gina sem texto extraÃ­vel]';
      });
      return {
        total_paginas: Number(totalPages) || normalizadas.length,
        paginas: normalizadas.length > 0 ? normalizadas : ['Nenhum texto extraÃ­do do PDF.'],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Falha durante anÃ¡lise do PDF (unpdf): ${msg}`);
    } finally {
      (process.stdout as any).write = realStdoutWrite;
    }
  }

  private storeCookies(response: Response): void {
    const setCookieHeaders = (response.headers as any).raw()['set-cookie'];
    if (!setCookieHeaders) return;

    for (const header of setCookieHeaders) {
      // Pega só o "nome=valor" (antes do primeiro ;)
      const cookiePart = header.split(';')[0].trim();
      const eqIndex = cookiePart.indexOf('=');
      if (eqIndex > 0) {
        const name = cookiePart.substring(0, eqIndex);
        const value = cookiePart.substring(eqIndex + 1);
        this.cookies.set(name, value);
      }
    }
  }

  /**
   * Monta o header Cookie a partir dos cookies armazenados.
   */
  private getCookieHeader(): string {
    const parts: string[] = [];
    for (const [name, value] of this.cookies) {
      parts.push(`${name}=${value}`);
    }
    return parts.join('; ');
  }

  private buildHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
      ...extra,
    };
    const cookieHeader = this.getCookieHeader();
    if (cookieHeader) headers.Cookie = cookieHeader;
    return headers;
  }

  private async fetchText(
    url: string,
    init: {
      method?: 'GET' | 'POST';
      headers?: Record<string, string>;
      body?: string;
      timeoutMs?: number;
      retries?: number;
      acceptHtmlError?: boolean;
    } = {},
  ): Promise<string> {
    const {
      method = 'GET',
      headers = {},
      body,
      timeoutMs = 30000,
      retries = this.FIORILLI_MAX_RETRIES,
      acceptHtmlError = false,
    } = init;

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= retries; attempt += 1) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;

      try {
        response = await fetch(url, {
          method,
          headers: this.buildHeaders(headers),
          body,
          signal: controller.signal as any,
        });
      } catch (err) {
        clearTimeout(timeoutId);
        const msg = err instanceof Error ? err.message : String(err);
        lastError = new Error(`Falha de conexao com o portal (tentativa ${attempt}/${retries}): ${msg}\nURL: ${url}`);
        if (attempt < retries) {
          await this.backoff(attempt);
          continue;
        }
        throw lastError;
      }

      clearTimeout(timeoutId);
      this.storeCookies(response);
      const text = await response.text();

      if (!response.ok) {
        if (this.shouldRetryStatus(response.status) && attempt < retries) {
          await this.backoff(attempt);
          continue;
        }
        if (!acceptHtmlError && this.isAspNetError(text)) {
          const errorDetail = this.extractAspNetError(text);
          throw new Error(
            `Erro no servidor do portal (HTTP ${response.status}).\nDetalhe: ${errorDetail}\nURL: ${url}`,
          );
        }
        throw new Error(`Erro HTTP ${response.status} ao acessar ${url}: ${text.substring(0, 500)}`);
      }

      if (!acceptHtmlError && this.isAspNetError(text)) {
        if (attempt < retries) {
          await this.backoff(attempt);
          continue;
        }
        throw new Error(`O portal retornou um erro ASP.NET ao acessar ${url}: ${this.extractAspNetError(text)}`);
      }

      return text;
    }

    throw lastError || new Error(`Falha desconhecida ao acessar ${url}`);
  }

  private decodeHtmlEntities(value: string): string {
    return String(value || '')
      .replace(/&#(\d+);/g, (_m, dec) => String.fromCharCode(Number(dec)))
      .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ');
  }

  private stripHtml(value: string): string {
    return this.decodeHtmlEntities(String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).trim();
  }

  private extractHiddenInputs(html: string): HiddenInputs {
    const hidden: HiddenInputs = {};
    const regex = /<input\b[^>]*>/gi;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(html)) !== null) {
      const tag = match[0];
      const nameMatch = tag.match(/\bname="([^"]+)"/i);
      if (!nameMatch) continue;
      const valueMatch = tag.match(/\bvalue="([^"]*)"/i);
      hidden[this.decodeHtmlEntities(nameMatch[1])] = this.decodeHtmlEntities(valueMatch?.[1] || '');
    }
    return hidden;
  }

  private parsePagerSummary(html: string): DespesasGeraisPage['summary'] {
    const summaryText = this.stripHtml(
      html.match(/Mostrando p&#225;gina[\s\S]*?Ordene os dados clicando no cabe&#231;alho das colunas\./i)?.[0] || '',
    );
    const summaryMatch = summaryText.match(/Mostrando p[áa]gina\s+(\d+)\s+-\s+Total de p[áa]ginas\s+-\s+(\d+)\s+-\s+Total de linhas\s+-\s+(\d+)/i);
    return {
      pagina_atual: summaryMatch ? Number(summaryMatch[1]) : 1,
      total_paginas: summaryMatch ? Number(summaryMatch[2]) : 1,
      total_linhas: summaryMatch ? Number(summaryMatch[3]) : 0,
    };
  }

  private parseDespesasGeraisRows(html: string): Record<string, string>[] {
    const fieldNamesByIndex = new Map<number, string>(
      Array.from(
      html.matchAll(/dxo\.CreateColumn\('',\d+,'([^']+)'/g),
        (match) => {
          const raw = match[0].match(/CreateColumn\('',(\d+),'([^']+)'/);
          return [Number(raw?.[1] || -1), raw?.[2] || ''];
        },
      ),
    );
    const visibleFieldIndexes = Array.from(
      new Set(
        Array.from(
          html.matchAll(/id="gridDespesas_DX-GST-col(\d+)"/g),
          (match) => Number(match[1]),
        ),
      ),
    );
    const rowBlocks = Array.from(
      html.matchAll(/<tr id="gridDespesas_DXDataRow\d+"[\s\S]*?<\/tr>/gi),
      (match) => match[0],
    );

    if (visibleFieldIndexes.length === 0 || rowBlocks.length === 0) {
      return [];
    }

    return rowBlocks.map((rowHtml) => {
      const cellValues = Array.from(
        rowHtml.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi),
        (match) => this.stripHtml(match[1]),
      );
      const dataCells = cellValues.slice(1);
      const row: Record<string, string> = {};
      for (let index = 0; index < visibleFieldIndexes.length && index < dataCells.length; index += 1) {
        const fieldName = fieldNamesByIndex.get(visibleFieldIndexes[index]);
        if (!fieldName) continue;
        row[fieldName] = dataCells[index];
      }
      return row;
    });
  }

  private parseDespesasGeraisTotals(html: string): Record<string, string> {
    const footerMatch = html.match(/<tr id="gridDespesas_DXFooterRow"[\s\S]*?<\/tr>/i);
    if (!footerMatch) return {};
    const footerCells = Array.from(
      footerMatch[0].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi),
      (match) => this.stripHtml(match[1]),
    );
    return {
      EMPENHADO_ATE_A_DATA: footerCells[13] || '',
      LIQUIDADO_ATE_A_DATA: footerCells[14] || '',
      PAGO_ATE_A_DATA: footerCells[15] || '',
      EMPENHADO: footerCells[16] || '',
      LIQUIDADO: footerCells[17] || '',
      PAGO: footerCells[18] || '',
    };
  }

  private parseCallbackResult(raw: string): string {
    const generalErrorMatch = raw.match(/['"]generalError['"]:\s*'([\s\S]*?)'/);
    if (generalErrorMatch) {
      const detail = generalErrorMatch[1]
        .replace(/\\r\\n/g, '\n')
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\\\/g, '\\')
        .replace(/\\'/g, "'")
        .replace(/\\"/g, '"')
        .replace(/\\\//g, '/')
        .trim();
      throw new Error(`Callback da grade retornou erro do portal: ${detail}`);
    }

    const match = raw.match(/['"]result['"]:\s*'([\s\S]*)'\}\)\s*$/);
    if (!match?.[1]) {
      throw new Error(`Resposta de callback da grade nao veio no formato esperado. Prefixo: ${raw.slice(0, 180)}`);
    }
    return match[1]
      .replace(/\\r\\n/g, '\n')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\\\/g, '\\')
      .replace(/\\'/g, "'")
      .replace(/\\"/g, '"')
      .replace(/\\\//g, '/');
  }

  private async bootstrapPortalSession(): Promise<void> {
    await this.fetchText(`${this.baseUrl}/default.aspx`, {
      method: 'GET',
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      acceptHtmlError: true,
      retries: 2,
    });
  }

  private async prepararDespesasGerais(exercicio: string, empresa: string): Promise<void> {
    await this.bootstrapPortalSession();
    await this.fetchText(`${this.baseUrl}/default.aspx/RecuperarDados`, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: `${this.baseUrl}/default.aspx`,
      },
      body: JSON.stringify({
        strLnkButtonID: 'lnkDespesasPor_NotaEmpenho',
        strExercicio: exercicio,
        strEmpresa: empresa,
      }),
      retries: 2,
    });
  }

  private async carregarPaginaDespesasGerais(exercicio: string, empresa: string): Promise<DespesasGeraisPage> {
    await this.prepararDespesasGerais(exercicio, empresa);
    const html = await this.fetchText(`${this.baseUrl}/DespesasPorEntidade.aspx`, {
      method: 'GET',
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Referer: `${this.baseUrl}/default.aspx`,
      },
      acceptHtmlError: true,
    });

    const hiddenInputs = this.extractHiddenInputs(html);
    const callbackState = hiddenInputs['gridDespesas$CallbackState'];
    if (!callbackState) {
      throw new Error('A tela DespesasPorEntidade.aspx nao retornou o estado da grade esperado.');
    }

    return {
      rows: this.parseDespesasGeraisRows(html),
      summary: this.parsePagerSummary(html),
      totals: this.parseDespesasGeraisTotals(html),
      hiddenInputs,
      callbackState,
    };
  }

  private async avancarPaginaDespesasGerais(
    page: DespesasGeraisPage,
    dataInicial: string,
    dataFinal: string,
    callbackParam: string,
  ): Promise<DespesasGeraisPage> {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(page.hiddenInputs)) {
      form.set(key, value);
    }

    form.set('hfMostrarDetalheEmpenho', page.hiddenInputs.hfMostrarDetalheEmpenho || 'S');
    this.applyCalendarInputs(form, 'datDataInicial', dataInicial, page.hiddenInputs);
    this.applyCalendarInputs(form, 'datDataFinal', dataFinal, page.hiddenInputs);
    form.set('gridDespesas$CallbackState', page.callbackState || page.hiddenInputs['gridDespesas$CallbackState'] || '');
    form.set('gridDespesas$DXSyncInput', page.hiddenInputs['gridDespesas$DXSyncInput'] || '0 0 -1');
    form.set('__CALLBACKID', 'gridDespesas');
    form.set('__CALLBACKPARAM', callbackParam);

    const raw = await this.fetchText(`${this.baseUrl}/DespesasPorEntidade.aspx`, {
      method: 'POST',
      headers: {
        Accept: '*/*',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Referer: `${this.baseUrl}/DespesasPorEntidade.aspx?AcessoIndividual=lnkDespesasPor_NotaEmpenho`,
      },
      body: form.toString(),
      acceptHtmlError: true,
      retries: 2,
    });

    const html = this.parseCallbackResult(raw);
    const hiddenInputs = {
      ...page.hiddenInputs,
      ...this.extractHiddenInputs(html),
    };
    const callbackState = hiddenInputs['gridDespesas$CallbackState'];
    if (!callbackState) {
      throw new Error('Callback da grade de despesas gerais nao retornou novo estado da grid.');
    }

    return {
      rows: this.parseDespesasGeraisRows(html),
      summary: this.parsePagerSummary(html),
      totals: this.parseDespesasGeraisTotals(html),
      hiddenInputs,
      callbackState,
    };
  }

  private async atualizarFiltroDespesasGerais(
    page: DespesasGeraisPage,
    dataInicial: string,
    dataFinal: string,
  ): Promise<DespesasGeraisPage> {
    // Contrato real observado no portal via DevTools ao alterar as datas
    // da grade "Despesas Gerais" (DespesasPorEntidade.aspx).
    return this.avancarPaginaDespesasGerais(
      page,
      dataInicial,
      dataFinal,
      'c0:GB|32;14|CUSTOMCALLBACK12|AtualizaGrid;',
    );
  }

  private formatDateSlash(day: string, month: string, year: string): string {
    return `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
  }

  private applyCalendarInputs(
    form: URLSearchParams,
    prefix: 'datDataInicial' | 'datDataFinal',
    value: string,
    template: HiddenInputs,
  ): void {
    const parsed = this.parseDateInput(value);
    if (!parsed) {
      form.set(prefix, value);
      return;
    }

    const dd = String(parsed.getDate()).padStart(2, '0');
    const mm = String(parsed.getMonth() + 1).padStart(2, '0');
    const yyyy = String(parsed.getFullYear());
    const utcMs = String(Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate()));
    const usDate = `${mm}/${dd}/${yyyy}`;

    form.set(`${prefix}_Raw`, utcMs);
    form.set(prefix, `${dd}/${mm}/${yyyy}`);
    if (template[`${prefix}_DDDWS`]) form.set(`${prefix}_DDDWS`, template[`${prefix}_DDDWS`]);
    if (template[`${prefix}_DDD_C_FNPWS`]) form.set(`${prefix}_DDD_C_FNPWS`, template[`${prefix}_DDD_C_FNPWS`]);
    form.set(`${prefix}$DDD$C`, `${usDate}:${usDate}`);
  }

  private async requestDespesasGerais(params: Record<string, string>): Promise<any[]> {
    const exercicio = params.Exercicio;
    const empresa = params.Empresa;
    const dataInicial = this.formatDateSlash(params.DiaInicioPeriodo, params.MesInicialPeriodo, exercicio);
    const dataFinal = this.formatDateSlash(params.DiaFinalPeriodo, params.MesFinalPeriodo, exercicio);

    let page = await this.carregarPaginaDespesasGerais(exercicio, empresa);
    page = await this.atualizarFiltroDespesasGerais(page, dataInicial, dataFinal);
    const allRows = [...page.rows];
    const seenFingerprints = new Set<string>(page.rows.map((row) => JSON.stringify(row)));

    for (let index = 1; index < page.summary.total_paginas; index += 1) {
      page = await this.avancarPaginaDespesasGerais(page, dataInicial, dataFinal, 'c0:GB|20;12|PAGERONCLICK3|PBN;');
      if (page.rows.length === 0) {
        throw new Error(
          `A grade oficial de despesas gerais retornou pagina vazia ao navegar para a pagina ${index + 1}/${page.summary.total_paginas}.`,
        );
      }
      for (const row of page.rows) {
        const fingerprint = JSON.stringify(row);
        if (!seenFingerprints.has(fingerprint)) {
          seenFingerprints.add(fingerprint);
          allRows.push(row);
        }
      }
    }

    return allRows.map((row) => ({
      ...row,
      __meta_total_paginas: String(page.summary.total_paginas),
      __meta_total_linhas: String(page.summary.total_linhas),
      __meta_total_empenhado: page.totals.EMPENHADO || '',
      __meta_total_liquidado: page.totals.LIQUIDADO || '',
      __meta_total_pago: page.totals.PAGO || '',
    }));
  }

  /**
   * Executa uma chamada GET ao portal Fiorilli.
   * Mantém cookies de sessão ASP.NET entre chamadas.
   * @param path Caminho relativo (ex: /VersaoJson/Despesas/)
   * @param params Parâmetros de query string
   * @returns Dados JSON parseados
   */
  async request(path: string, params: Record<string, string>): Promise<any> {
    if (path === '/VersaoJson/Despesas/' && params.Listagem === 'DespesasGerais') {
      return this.requestDespesasGerais(params);
    }

    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.append(key, value);
      }
    }

    const finalUrl = url.toString();
    const headers: Record<string, string> = this.buildHeaders({ Accept: 'application/json' });

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.FIORILLI_MAX_RETRIES; attempt += 1) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);
      let response: Response;

      try {
        response = await fetch(finalUrl, {
          method: 'GET',
          headers,
          signal: controller.signal as any,
        });
      } catch (err) {
        clearTimeout(timeoutId);
        const msg = err instanceof Error ? err.message : String(err);
        lastError = new Error(
          `Falha de conexao com o portal (tentativa ${attempt}/${this.FIORILLI_MAX_RETRIES}): ${msg}\n` +
          `URL: ${finalUrl}`
        );
        if (attempt < this.FIORILLI_MAX_RETRIES) {
          await this.backoff(attempt);
          continue;
        }
        throw lastError;
      }

      clearTimeout(timeoutId);
      this.storeCookies(response);
      const text = await response.text();

      if (!response.ok) {
        if (this.shouldRetryStatus(response.status) && attempt < this.FIORILLI_MAX_RETRIES) {
          await this.backoff(attempt);
          continue;
        }
        if (this.isAspNetError(text)) {
          const errorDetail = this.extractAspNetError(text);
          throw new Error(
            `Erro no servidor do portal (HTTP ${response.status}).\n` +
            `Detalhe: ${errorDetail}\n` +
            `URL: ${finalUrl}\n` +
            `Isso geralmente indica parametros invalidos ou endpoint indisponivel.`
          );
        }
        throw new Error(`Erro HTTP ${response.status} ao acessar ${finalUrl}: ${text.substring(0, 500)}`);
      }

      if (!text || text.trim() === '') {
        return { message: 'O portal retornou uma resposta vazia.', data: [] };
      }

      if (this.isAspNetError(text)) {
        if (attempt < this.FIORILLI_MAX_RETRIES) {
          await this.backoff(attempt);
          continue;
        }
        const errorDetail = this.extractAspNetError(text);
        throw new Error(
          `O portal retornou um erro do servidor (ASP.NET).\n` +
          `Detalhe: ${errorDetail}\n` +
          `URL: ${finalUrl}\n` +
          `Isso geralmente indica parametros invalidos ou endpoint indisponivel neste municipio.`
        );
      }

      const listagem = params.Listagem || '';
      try {
        return JSON.parse(text);
      } catch {
        if (listagem === 'DefineExercicio') {
          return {
            status: 'ok',
            listagem,
            format: 'html',
            message: 'DefineExercicio executado (resposta HTML do portal).',
          };
        }
        if (text.trimStart().startsWith('<') && attempt < this.FIORILLI_MAX_RETRIES) {
          await this.backoff(attempt);
          continue;
        }
        if (text.trimStart().startsWith('<')) {
          throw new Error(
            `O portal retornou HTML em vez de JSON.\n` +
            `URL: ${finalUrl}\n` +
            `Isso pode indicar que o endpoint nao esta disponivel ou os parametros estao incorretos.\n` +
            `Resposta (primeiros 200 chars): ${text.substring(0, 200)}`
          );
        }
        throw new Error(
          `Resposta nao e JSON valido de ${finalUrl}.\nPrimeiros 300 chars: ${text.substring(0, 300)}`
        );
      }
    }

    throw lastError || new Error(`Falha desconhecida ao acessar ${finalUrl}`);
  }

  /**
   * Detecta se o conteúdo é uma página de erro ASP.NET
   */
  private isAspNetError(text: string): boolean {
    return (
      text.includes('Erro no tempo de execu') ||
      text.includes('Server Error in') ||
      text.includes('Runtime Error') ||
      text.includes('customErrors') ||
      text.includes('Application Error') ||
      text.includes('Erro de Servidor no Aplicativo')
    );
  }

  /**
   * Extrai informação útil de uma página de erro ASP.NET
   */
  private extractAspNetError(html: string): string {
    // Tenta extrair título do erro
    const titleMatch = html.match(/<title>(.*?)<\/title>/i);
    if (titleMatch) {
      return titleMatch[1].replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    }

    // Tenta extrair descrição
    const descMatch = html.match(/<b>\s*Descri[çc][aã]o:\s*<\/b>(.*?)(?:<br|<\/p)/i);
    if (descMatch) {
      return descMatch[1].replace(/<[^>]+>/g, '').trim();
    }

    return 'Erro interno do servidor. O portal retornou uma pagina de erro ASP.NET.';
  }

  /**
   * Limpa os cookies armazenados (útil ao trocar de portal).
   */
  clearCookies(): void {
    this.cookies.clear();
  }

  // ─── ID do município no DOSP (Paraguaçu Paulista = 5050) ─────────────────
  private readonly DOSP_MUNICIPIO_ID = '5050';

  // Seções disponíveis no Diário Oficial
  static readonly SECOES_DIARIO: Record<string, string> = {
    '11': 'Advertências / Notificações',
    '3': 'Atos Administrativos',
    '2': 'Atos Legislativos',
    '1': 'Atos Oficiais',
    '6': 'Concursos Públicos/Processos Seletivos',
    '15': 'Conselhos Municipais',
    '5': 'Contas Públicas e Instrumentos de Gestão Fiscal',
    '4': 'Licitações e Contratos',
    '7': 'Outros Atos',
  };

  /**
   * Extrai dados JSON de resposta JSONP do DOSP
   */
  private parseJsonpResponse(text: string): any {
    // JSONP: callback_name({...}) ou callback_name([...])
    // Tenta extrair o JSON de dentro do callback
    const match = text.match(/^[^(]*\(([\s\S]*)\)\s*;?\s*$/);
    if (match && match[1]) {
      return JSON.parse(match[1]);
    }
    // Tenta parsear direto como JSON
    return JSON.parse(text);
  }

  /**
   * Faz requisição JSONP ao DOSP API e retorna os dados parseados
   */
  private async dospRequest(endpoint: string): Promise<any> {
    const url = `https://dosp.com.br/api/index.php/${endpoint}?callback=dioe`;
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    try {
      const res = await fetch(url, {
        signal: controller.signal as any,
        headers: {
          'Accept': '*/*',
          'User-Agent': 'Mozilla/5.0 (compatible; MCP-Server/1.0)',
        }
      });
      clearTimeout(timeoutId);

      if (!res.ok) {
        throw new Error(`Erro ao acessar DOSP API: HTTP ${res.status}`);
      }

      const text = await res.text();
      
      if (!text || text.trim() === '') {
        return { data: [] };
      }

      return this.parseJsonpResponse(text);
    } catch (err) {
      clearTimeout(timeoutId);
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Falha ao acessar API do Diário Oficial: ${msg}`);
    }
  }

  /**
   * Formata um item do diário retornado pela API DOSP
   */
  private async dospRequestRobust(endpoint: string): Promise<any> {
    const url = `https://dosp.com.br/api/index.php/${endpoint}?callback=dioe`;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.DOSP_MAX_RETRIES; attempt += 1) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);
      let res: Response;

      try {
        res = await fetch(url, {
          signal: controller.signal as any,
          headers: {
            Accept: '*/*',
            'User-Agent': 'Mozilla/5.0 (compatible; MCP-Server/1.0)',
          },
        });
      } catch (err) {
        clearTimeout(timeoutId);
        const msg = err instanceof Error ? err.message : String(err);
        lastError = new Error(
          `Falha ao acessar API do Diario Oficial (tentativa ${attempt}/${this.DOSP_MAX_RETRIES}): ${msg}`,
        );
        if (attempt < this.DOSP_MAX_RETRIES) {
          await this.backoff(attempt);
          continue;
        }
        throw lastError;
      }

      clearTimeout(timeoutId);
      if (!res.ok) {
        if (this.shouldRetryStatus(res.status) && attempt < this.DOSP_MAX_RETRIES) {
          await this.backoff(attempt);
          continue;
        }
        throw new Error(`Erro ao acessar DOSP API: HTTP ${res.status}`);
      }

      const text = await res.text();
      if (!text || text.trim() === '') {
        return { data: [] };
      }

      try {
        return this.parseJsonpResponse(text);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        lastError = new Error(
          `Resposta invalida da API do Diario Oficial (tentativa ${attempt}/${this.DOSP_MAX_RETRIES}): ${msg}`,
        );
        if (attempt < this.DOSP_MAX_RETRIES) {
          await this.backoff(attempt);
          continue;
        }
        throw lastError;
      }
    }

    throw lastError || new Error('Falha desconhecida ao acessar API do Diario Oficial.');
  }

  private formatarItemDiario(item: any): any {
    const iddo = String(item.iddo);
    const base64Id = Buffer.from(iddo).toString('base64');
    
    // Parsear a data
    const md = new Date(item.data);
    md.setMinutes(md.getMinutes() + md.getTimezoneOffset());
    
    const dia = md.getDate().toString().padStart(2, '0');
    const mes = (md.getUTCMonth() + 1).toString().padStart(2, '0');
    const ano = md.getUTCFullYear().toString();
    const dataFormatada = `${dia}/${mes}/${ano}`;
    const anoDoRaw = String(item.ano_do ?? '').trim();
    const edicaoAno = /^\d{4}$/.test(anoDoRaw) ? anoDoRaw : ano;

    return {
      id_do: String(item.iddo),
      data: dataFormatada,
      data_iso: `${ano}-${mes}-${dia}`,
      edicao_num: String(item.edicao_do),
      edicao_ano: edicaoAno,
      paginas: Number(item.pgtotal) || 0,
      flag_extra: item.flag_extra === 1,
      url_original_eletronico: `https://dosp.com.br/exibe_do.php?i=${base64Id}`,
      url_modo_texto: `https://imprensaoficialmunicipal.com.br/leiturajornal.php?c=Paragua%C3%A7u%20Paulista&i=${base64Id}`,
      url_pdf_direto: `https://dosp.com.br/exibe_do.php?i=${base64Id}`,
    };
  }

  private parseDateInput(value: string): Date | null {
    const raw = String(value || '').trim();
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

  private toIsoDate(date: Date): string {
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  /**
   * Lista TODAS as edições do Diário Oficial (sem filtro).
   * Retorna em ordem cronológica decrescente (mais recente primeiro).
   * @param pagina Página para retornar (1-indexed), cada página com `porPagina` itens
   * @param porPagina Itens por página (padrão 10)
   */
  async listarDiarios(pagina: number = 1, porPagina: number = 10): Promise<{
    edicoes: any[];
    total: number;
    pagina: number;
    total_paginas: number;
  }> {
    const cacheKey = `dioe:${this.DOSP_MUNICIPIO_ID}`;
    const cachedList = this.getCachedValue(this.diarioListaCache, cacheKey);
    let allData: any[] = cachedList ?? [];
    if (cachedList === null) {
      const response = await this.dospRequestRobust(`dioe.js/${this.DOSP_MUNICIPIO_ID}`);
      allData = response.data || [];
      this.setCachedValue(this.diarioListaCache, cacheKey, allData, this.DIARIO_LIST_TTL_MS);
    }
    const total = allData.length;
    const totalPaginas = Math.ceil(total / porPagina);
    const startIdx = (pagina - 1) * porPagina;
    const endIdx = Math.min(startIdx + porPagina, total);
    
    const edicoes = allData.slice(startIdx, endIdx).map((item: any) => this.formatarItemDiario(item));
    this.diarioIndex.upsertDocuments(edicoes);

    return {
      edicoes,
      total,
      pagina,
      total_paginas: totalPaginas,
    };
  }

  /**
   * Filtra edições do Diário Oficial por data.
   * @param dataInicial Data inicial no formato YYYY-MM-DD
   * @param dataFinal Data final no formato YYYY-MM-DD
   * @param pagina Página (1-indexed)
   * @param porPagina Itens por página
   */
  async listarDiariosPorData(
    dataInicial: string = '',
    dataFinal: string = '',
    pagina: number = 1,
    porPagina: number = 10
  ): Promise<{
    edicoes: any[];
    total: number;
    pagina: number;
    total_paginas: number;
      filtro: { data_inicial: string; data_final: string };
  }> {
    const cacheKey = `dioe:${this.DOSP_MUNICIPIO_ID}`;
    const cachedList = this.getCachedValue(this.diarioListaCache, cacheKey);
    let allData: any[] = cachedList ?? [];
    if (cachedList === null) {
      const response = await this.dospRequestRobust(`dioe.js/${this.DOSP_MUNICIPIO_ID}`);
      allData = response.data || [];
      this.setCachedValue(this.diarioListaCache, cacheKey, allData, this.DIARIO_LIST_TTL_MS);
    }

    const inicio = this.parseDateInput(dataInicial);
    const fim = this.parseDateInput(dataFinal);
    const filtradas = allData.filter((item: any) => {
      const formatted = this.formatarItemDiario(item);
      if (!inicio && !fim) return true;
      const rawDate = this.parseDateInput(formatted.data);
      if (!rawDate) return false;
      if (inicio && rawDate < inicio) return false;
      if (fim && rawDate > fim) return false;
      return true;
    });
    const total = filtradas.length;
    const totalPaginas = Math.ceil(total / porPagina);
    const startIdx = (pagina - 1) * porPagina;
    const endIdx = Math.min(startIdx + porPagina, total);
    const edicoes = filtradas.slice(startIdx, endIdx).map((item: any) => this.formatarItemDiario(item));
    this.diarioIndex.upsertDocuments(edicoes);

    return {
      edicoes,
      total,
      pagina,
      total_paginas: totalPaginas,
      filtro: { data_inicial: dataInicial, data_final: dataFinal },
    };
  }

  /**
   * Filtra edições do Diário Oficial por seção.
   * @param idSecao ID da seção (ex: 1=Atos Oficiais, 4=Licitações)
   * @param pagina Página (1-indexed)
   * @param porPagina Itens por página
   */
  async listarDiariosPorSecao(
    idSecao: string,
    pagina: number = 1,
    porPagina: number = 10
  ): Promise<{
    edicoes: any[];
    total: number;
    pagina: number;
    total_paginas: number;
    filtro: { secao_id: string; secao_nome: string };
  }> {
    const endpoint = `filtrasecao.js/${this.DOSP_MUNICIPIO_ID}/${idSecao}`;
    const response = await this.dospRequestRobust(endpoint);
    
    const allData: any[] = response.data || [];
    const total = allData.length;
    const totalPaginas = Math.ceil(total / porPagina);
    const startIdx = (pagina - 1) * porPagina;
    const endIdx = Math.min(startIdx + porPagina, total);
    
    const edicoes = allData.slice(startIdx, endIdx).map((item: any) => {
      const formatted = this.formatarItemDiario(item);
      formatted.quantidade_na_secao = item.quantidade;
      return formatted;
    });
    this.diarioIndex.upsertDocuments(edicoes);

    const secaoNome = FiorilliApiClient.SECOES_DIARIO[idSecao] || `Seção ${idSecao}`;

    return {
      edicoes,
      total,
      pagina,
      total_paginas: totalPaginas,
      filtro: { secao_id: idSecao, secao_nome: secaoNome },
    };
  }

  /**
   * Pesquisa edições do Diário Oficial por termo de busca.
   * Mantida para compatibilidade - usa o endpoint de pesquisa do imprensaoficialmunicipal.
   */
  async pesquisarDiarioOficial(
    termo: string,
    dataInicial: string = '',
    dataFinal: string = ''
  ): Promise<any[]> {
    const params = new URLSearchParams();
    params.append('termo', termo);
    params.append('secao', '');
    params.append('datai', dataInicial);
    params.append('dataf', dataFinal);
    params.append('btnSubmitsrc', 'Pesquisar');

    const res = await fetch('https://imprensaoficialmunicipal.com.br/pesquisar.php?c=paraguacu_paulista', {
      method: 'POST',
      body: params,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    if (!res.ok) {
      throw new Error(`Erro na busca do Diário Oficial: ${res.statusText}`);
    }

    const html = await res.text();
    
    // Server inserts JSON exactly into variable var dioe = [...]
    const scriptMatch = html.match(/var\s*dioe\s*=\s*(\[[\s\S]*?\]);/i);
    
    if (scriptMatch && scriptMatch[1]) {
      try {
        const jsonData = JSON.parse(scriptMatch[1]);
        return jsonData;
      } catch (err) {
        throw new Error('Falha ao processar o JSON do Diário Oficial.');
      }
    }
    
    return []; // Nenhuma edição encontrada
  }

  /**
   * Extrai texto do Diário Oficial via modo leitura (HTML do imprensaoficialmunicipal).
   * Mais confiável para extração de texto do que PDF parse.
   */
  async extrairTextoModoLeitura(urlOuBase64Id: string): Promise<string> {
    let url: string;
    
    // Se já é uma URL completa, usa direto
    if (urlOuBase64Id.startsWith('http')) {
      url = urlOuBase64Id;
    } else {
      // Assume que é um base64 ID
      url = `https://imprensaoficialmunicipal.com.br/leiturajornal.php?c=Paragua%C3%A7u%20Paulista&i=${urlOuBase64Id}`;
    }

    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MCP-Server/1.0)',
      }
    });
    
    if (!res.ok) {
      throw new Error(`Falha ao acessar modo leitura: HTTP ${res.status}`);
    }

    const html = await res.text();
    
    // Remove tags HTML e extrai o texto legível
    // Foca na div de conteúdo principal
    let text = html;
    
    // Remove scripts e styles
    text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
    text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
    
    // Remove tags HTML preservando conteúdo
    text = text.replace(/<br\s*\/?>/gi, '\n');
    text = text.replace(/<\/p>/gi, '\n\n');
    text = text.replace(/<\/div>/gi, '\n');
    text = text.replace(/<\/h[1-6]>/gi, '\n\n');
    text = text.replace(/<\/li>/gi, '\n');
    text = text.replace(/<[^>]+>/g, '');
    
    // Decode HTML entities
    text = text.replace(/&amp;/g, '&');
    text = text.replace(/&lt;/g, '<');
    text = text.replace(/&gt;/g, '>');
    text = text.replace(/&quot;/g, '"');
    text = text.replace(/&#39;/g, "'");
    text = text.replace(/&nbsp;/g, ' ');
    
    // Limpa espaços excessivos
    text = text.replace(/[ \t]+/g, ' ');
    text = text.replace(/\n{3,}/g, '\n\n');
    text = text.trim();

    if (!text || text.length < 50) {
      return 'Não foi possível extrair texto significativo desta edição no modo leitura.';
    }

    return text;
  }

  private normalizeSearchText(value: string): string {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  }

  private findKeywordSnippets(
    text: string,
    termo: string,
    maxSnippets: number = 3,
    contexto: number = 160
  ): Array<{ trecho: string; inicio: number }> {
    const original = String(text || '');
    const needle = this.normalizeSearchText(termo).trim();
    if (!needle) return [];

    const haystack = this.normalizeSearchText(original);
    const snippets: Array<{ trecho: string; inicio: number }> = [];
    let idx = haystack.indexOf(needle);

    while (idx !== -1 && snippets.length < maxSnippets) {
      const start = Math.max(0, idx - contexto);
      const end = Math.min(original.length, idx + needle.length + contexto);
      const trecho = original.slice(start, end).replace(/\s+/g, ' ').trim();
      if (trecho) {
        snippets.push({ trecho, inicio: idx });
      }
      idx = haystack.indexOf(needle, idx + Math.max(1, needle.length));
    }

    return snippets;
  }

  private async extrairPdfPaginasComLock(url: string): Promise<PdfTextExtraction> {
    const cached = this.getCachedValue(this.pdfPaginasCache, url);
    if (cached) return cached;

    return this.withPdfExtractionLock(async () => {
      let res;
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 45000);
        res = await fetch(url, {
          signal: controller.signal as any,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
            'Accept': 'application/pdf,text/html,application/xhtml+xml,*/*;q=0.8',
            'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
            'Upgrade-Insecure-Requests': '1'
          }
        });
        clearTimeout(timeoutId);
      } catch (fetchErr) {
        const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
        throw new Error(`Falha ao baixar o PDF: ${msg}. URL: ${url}`);
      }

      if (!res.ok) {
        throw new Error(`Falha ao baixar o PDF: HTTP ${res.status} ${res.statusText}. URL: ${url}`);
      }

      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('text/html') || contentType.includes('text/plain')) {
        const body = await res.text();
        const preview = body.substring(0, 300).replace(/\n/g, ' ');
        throw new Error(`A URL não retornou PDF válido. Content-Type: ${contentType}. Preview: ${preview}`);
      }

      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length < 5) {
        throw new Error(`Resposta muito curta (${bytes.length} bytes) — não é um PDF válido. URL: ${url}`);
      }

      const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
      if (magic !== '%PDF') {
        const preview = new TextDecoder('utf-8', { fatal: false })
          .decode(bytes.slice(0, 300))
          .replace(/\n/g, ' ');
        throw new Error(`Conteúdo retornado não é PDF válido. Preview: ${preview}`);
      }

      const realStdoutWrite = process.stdout.write;
      const realStderrWrite = process.stderr.write;
      try {
        (process.stdout as any).write = function (chunk: any, ...args: any[]) {
          return (process.stderr as any).write(chunk, ...args);
        };
        (process.stderr as any).write = function () {
          return true;
        };

        const { text: rawText, totalPages } = await extractText(bytes, { mergePages: false });
        const paginas = Array.isArray(rawText) ? rawText : [String(rawText ?? '')];
        const normalizadas = paginas.map((pagina) => {
          const limpa = String(pagina || '').replace(/\s+\n/g, '\n').trim();
          return limpa || '[Página sem texto extraível]';
        });
        const parsed = {
          total_paginas: Number(totalPages) || normalizadas.length,
          paginas: normalizadas.length > 0 ? normalizadas : ['Nenhum texto extraído do PDF.'],
        };
        return this.setCachedValue(this.pdfPaginasCache, url, parsed, this.PDF_TEXT_TTL_MS);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Falha durante análise do PDF (unpdf): ${msg}`);
      } finally {
        (process.stdout as any).write = realStdoutWrite;
        (process.stderr as any).write = realStderrWrite;
      }
    });
  }

  async extrairTextoPdfPaginasSeguro(url: string): Promise<PdfTextExtraction> {
    return this.extrairPdfPaginasComLock(url);
  }

  async buscarDiarioPorTermo(
    termo: string,
    dataInicial: string = '',
    dataFinal: string = '',
    fonte: 'pdf' = 'pdf',
    options?: { offset?: number; limit?: number }
  ): Promise<{
    termo: string;
    fonte: 'pdf';
    total_candidatos: number;
    documentos_processados: number;
    scan_completo: boolean;
    proximo_offset?: number;
    total_documentos_com_match: number;
    total_documentos_indexados: number;
    total_matches: number;
    matches: DiarioBuscaSnippet[];
    falhas: Array<{ documento: any; erro: string }>;
  }> {
    const todos = (await this.listarDiarios(1, 100000)).edicoes;
    const inicio = this.parseDateInput(dataInicial);
    const fim = this.parseDateInput(dataFinal);
    const dataInicialIso = inicio ? this.toIsoDate(inicio) : undefined;
    const dataFinalIso = fim ? this.toIsoDate(fim) : undefined;
    const candidatos = todos.filter((doc: any) => {
      if (!inicio && !fim) return true;
      const rawDate = this.parseDateInput(doc.data);
      if (!rawDate) return false;
      if (inicio && rawDate < inicio) return false;
      if (fim && rawDate > fim) return false;
      return true;
    });

    const documentos = candidatos.map((item: any) => {
      if (item && typeof item === 'object' && 'url_pdf_direto' in item) {
        return item;
      }
      return this.formatarItemDiario(item);
    });
    const unicos = new Map<string, any>();

    for (const doc of documentos) {
      const chave = String(doc.id_do || doc.edicao_num || doc.url_pdf_direto);
      if (!unicos.has(chave)) {
        unicos.set(chave, doc);
      }
    }

    const docs = [...unicos.values()];
    this.diarioIndex.upsertDocuments(docs);
    const offset = Math.max(0, Number(options?.offset) || 0);
    const limit = Math.max(1, Number(options?.limit) || 10);
    const lote = docs.slice(offset, offset + limit);

    const falhas: Array<{ documento: any; erro: string }> = [];

    for (const documento of lote) {
      try {
        const missing = this.diarioIndex.getMissingDocuments([documento]);
        if (missing.length === 0) continue;
        const pdf = await this.extrairPdfPaginasComLock(documento.url_pdf_direto);
        this.diarioIndex.indexDocument(documento, pdf.paginas);
      } catch (err) {
        falhas.push({
          documento,
          erro: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const indexedMatches = this.diarioIndex.search(
      termo,
      {
        dataInicial: dataInicialIso,
        dataFinal: dataFinalIso,
      },
      5000,
    );
    const matches: DiarioBuscaSnippet[] = indexedMatches.map((match) => ({
      documento: match.documento,
      termo,
      fonte: 'pdf',
      pagina: match.pagina,
      ocorrencias_na_pagina: 1,
      trecho: match.trecho,
    }));

    return {
      termo,
      fonte: 'pdf',
      total_candidatos: docs.length,
      documentos_processados: lote.length,
      scan_completo: offset + lote.length >= docs.length,
      proximo_offset: offset + lote.length < docs.length ? offset + lote.length : undefined,
      total_documentos_indexados: this.diarioIndex.countIndexedDocuments({
        dataInicial: dataInicialIso,
        dataFinal: dataFinalIso,
      }),
      total_documentos_com_match: new Set(matches.map((m) => m.documento.id_do)).size,
      total_matches: matches.length,
      matches,
      falhas,
    };
  }
}

