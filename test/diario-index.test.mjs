import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { DiarioIndex } from '../dist/diario-index.js';

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-diario-index-'));
}

function buildDoc(overrides = {}) {
  return {
    id_do: '100',
    data: '10/01/2026',
    data_iso: '2026-01-10',
    edicao_num: '1275',
    edicao_ano: '2026',
    paginas: 2,
    flag_extra: false,
    url_original_eletronico: 'https://dosp.com.br/exibe_do.php?i=abc',
    url_modo_texto: 'https://imprensaoficialmunicipal.com.br/leiturajornal.php?i=abc',
    url_pdf_direto: 'https://dosp.com.br/exibe_do.php?i=abc',
    ...overrides,
  };
}

function closeAndCleanup(index, tempDir) {
  try {
    index?.db?.close?.();
  } catch {}
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
}

test('indexa documento, normaliza id e busca com filtros', () => {
  const tempDir = createTempDir();
  const index = new DiarioIndex(tempDir);
  try {
    const doc = buildDoc({ id_do: '100.0' });
    const doc2 = buildDoc({
      id_do: '200',
      data: '20/02/2026',
      data_iso: '2026-02-20',
      edicao_num: '1300',
      url_pdf_direto: 'https://dosp.com.br/exibe_do.php?i=def',
    });

    index.upsertDocuments([doc, doc2]);
    const missingBefore = index.getMissingDocuments([doc, doc2]);
    assert.equal(missingBefore.length, 2);

    index.indexDocument(doc, ['Carlos Daniel Viana Ferrer solicitou exoneração.']);
    index.indexDocument(doc2, ['Licitação pública para saúde e educação municipal.']);

    const missingAfter = index.getMissingDocuments([doc, doc2]);
    assert.equal(missingAfter.length, 0);

    const matchNome = index.search('viana', { dataInicial: '2026-01-01', dataFinal: '2026-01-31' }, 10);
    assert.equal(matchNome.length, 1);
    assert.equal(matchNome[0].documento.id_do, '100');

    const matchAcento = index.search('licitacao', { dataInicial: '2026-02-01', dataFinal: '2026-02-28' }, 10);
    assert.equal(matchAcento.length, 1);
    assert.equal(matchAcento[0].documento.id_do, '200');

    const countJan = index.countIndexedDocuments({ dataInicial: '2026-01-01', dataFinal: '2026-01-31' });
    const countAll = index.countIndexedDocuments({});
    assert.equal(countJan, 1);
    assert.equal(countAll, 2);
  } finally {
    closeAndCleanup(index, tempDir);
  }
});
