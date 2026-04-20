import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

type DiarioDocumento = {
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

export type DiarioIndexMatch = {
  documento: DiarioDocumento;
  pagina: number;
  trecho: string;
  score: number;
};

export class DiarioIndex {
  private db: Database.Database;
  private upsertDocStmt: Database.Statement;
  private deletePagesStmt: Database.Statement;
  private insertPageStmt: Database.Statement;
  private markIndexedStmt: Database.Statement;

  constructor(dataDir?: string) {
    const baseDir = dataDir || process.env.MCP_DATA_DIR || path.resolve(process.cwd(), '.mcp-data');
    fs.mkdirSync(baseDir, { recursive: true });
    const dbPath = path.join(baseDir, 'diario-index.db');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('temp_store = MEMORY');
    this.ensureSchema();

    this.upsertDocStmt = this.db.prepare(`
      INSERT INTO diario_docs (
        id_do, data, data_iso, edicao_num, edicao_ano, paginas, flag_extra,
        url_original_eletronico, url_modo_texto, url_pdf_direto, indexed_at
      ) VALUES (
        @id_do, @data, @data_iso, @edicao_num, @edicao_ano, @paginas, @flag_extra,
        @url_original_eletronico, @url_modo_texto, @url_pdf_direto, NULL
      )
      ON CONFLICT(id_do) DO UPDATE SET
        data = excluded.data,
        data_iso = excluded.data_iso,
        edicao_num = excluded.edicao_num,
        edicao_ano = excluded.edicao_ano,
        paginas = excluded.paginas,
        flag_extra = excluded.flag_extra,
        url_original_eletronico = excluded.url_original_eletronico,
        url_modo_texto = excluded.url_modo_texto,
        url_pdf_direto = excluded.url_pdf_direto
    `);
    this.deletePagesStmt = this.db.prepare(`DELETE FROM diario_pages WHERE id_do = ?`);
    this.insertPageStmt = this.db.prepare(`
      INSERT INTO diario_pages (id_do, data_iso, edicao_num, page_num, text)
      VALUES (?, ?, ?, ?, ?)
    `);
    this.markIndexedStmt = this.db.prepare(`
      UPDATE diario_docs
      SET indexed_at = CURRENT_TIMESTAMP
      WHERE id_do = ?
    `);
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS diario_docs (
        id_do TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        data_iso TEXT NOT NULL,
        edicao_num TEXT NOT NULL,
        edicao_ano TEXT NOT NULL,
        paginas INTEGER NOT NULL,
        flag_extra INTEGER NOT NULL DEFAULT 0,
        url_original_eletronico TEXT NOT NULL,
        url_modo_texto TEXT NOT NULL,
        url_pdf_direto TEXT NOT NULL,
        indexed_at TEXT
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS diario_pages USING fts5(
        id_do UNINDEXED,
        data_iso UNINDEXED,
        edicao_num UNINDEXED,
        page_num UNINDEXED,
        text,
        tokenize = 'unicode61 remove_diacritics 2'
      );

      CREATE INDEX IF NOT EXISTS idx_diario_docs_data_iso ON diario_docs (data_iso);
      CREATE INDEX IF NOT EXISTS idx_diario_docs_indexed_at ON diario_docs (indexed_at);
    `);
    this.db.exec(`
      DELETE FROM diario_pages WHERE CAST(id_do AS TEXT) LIKE '%.0';
      UPDATE diario_docs SET id_do = REPLACE(id_do, '.0', '') WHERE id_do LIKE '%.0';
      UPDATE diario_docs SET indexed_at = NULL WHERE id_do NOT IN (SELECT DISTINCT CAST(id_do AS TEXT) FROM diario_pages);
    `);
  }

  private normalizeDocId(value: unknown): string {
    return String(value ?? '').replace(/\.0+$/, '');
  }

  upsertDocuments(documentos: DiarioDocumento[]): void {
    const tx = this.db.transaction((docs: DiarioDocumento[]) => {
      for (const doc of docs) {
        this.upsertDocStmt.run({
          ...doc,
          id_do: this.normalizeDocId(doc.id_do),
          edicao_ano: String(doc.edicao_ano),
          flag_extra: doc.flag_extra ? 1 : 0,
        });
      }
    });
    tx(documentos);
  }

  getMissingDocuments(documentos: DiarioDocumento[]): DiarioDocumento[] {
    if (documentos.length === 0) return [];
    const stmt = this.db.prepare(`
      SELECT id_do
      FROM diario_docs
      WHERE id_do = ? AND indexed_at IS NOT NULL
    `);
    return documentos.filter((doc) => !stmt.get(this.normalizeDocId(doc.id_do)));
  }

  indexDocument(documento: DiarioDocumento, paginas: string[]): void {
    const tx = this.db.transaction((doc: DiarioDocumento, pages: string[]) => {
      this.upsertDocuments([doc]);
      const docId = this.normalizeDocId(doc.id_do);
      this.deletePagesStmt.run(docId);
      pages.forEach((text, idx) => {
        this.insertPageStmt.run(docId, doc.data_iso, doc.edicao_num, idx + 1, text);
      });
      this.markIndexedStmt.run(docId);
    });
    tx(documento, paginas);
  }

  search(term: string, filters: { dataInicial?: string; dataFinal?: string }, limit: number = 1000): DiarioIndexMatch[] {
    const normalized = String(term || '').trim().replace(/"/g, '""');
    if (!normalized) return [];

    const where: string[] = ['diario_pages MATCH ?'];
    const params: unknown[] = [`"${normalized}"`];

    if (filters.dataInicial) {
      where.push('d.data_iso >= ?');
      params.push(filters.dataInicial);
    }
    if (filters.dataFinal) {
      where.push('d.data_iso <= ?');
      params.push(filters.dataFinal);
    }

    params.push(limit);

    const rows = this.db.prepare(`
      SELECT
        d.id_do,
        d.data,
        d.data_iso,
        d.edicao_num,
        d.edicao_ano,
        d.paginas,
        d.flag_extra,
        d.url_original_eletronico,
        d.url_modo_texto,
        d.url_pdf_direto,
        diario_pages.page_num AS page_num,
        snippet(diario_pages, 4, '', '', ' ... ', 32) AS trecho,
        bm25(diario_pages) AS score
      FROM diario_pages
      JOIN diario_docs d ON d.id_do = diario_pages.id_do
      WHERE ${where.join(' AND ')}
      ORDER BY score, d.data_iso DESC, diario_pages.page_num ASC
      LIMIT ?
    `).all(...params) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      documento: {
        id_do: String(row.id_do),
        data: String(row.data),
        data_iso: String(row.data_iso),
        edicao_num: String(row.edicao_num),
        edicao_ano: String(row.edicao_ano),
        paginas: Number(row.paginas) || 0,
        flag_extra: Number(row.flag_extra) === 1,
        url_original_eletronico: String(row.url_original_eletronico),
        url_modo_texto: String(row.url_modo_texto),
        url_pdf_direto: String(row.url_pdf_direto),
      },
      pagina: Number(row.page_num) || 0,
      trecho: String(row.trecho || ''),
      score: Number(row.score) || 0,
    }));
  }

  countIndexedDocuments(filters: { dataInicial?: string; dataFinal?: string }): number {
    const where: string[] = ['indexed_at IS NOT NULL'];
    const params: unknown[] = [];
    if (filters.dataInicial) {
      where.push('data_iso >= ?');
      params.push(filters.dataInicial);
    }
    if (filters.dataFinal) {
      where.push('data_iso <= ?');
      params.push(filters.dataFinal);
    }
    const row = this.db.prepare(`
      SELECT COUNT(*) AS total
      FROM diario_docs
      WHERE ${where.join(' AND ')}
    `).get(...params) as { total?: number } | undefined;
    return Number(row?.total) || 0;
  }
}
