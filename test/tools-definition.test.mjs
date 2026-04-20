import test from 'node:test';
import assert from 'node:assert/strict';
import { ALL_TOOLS, ANALYSIS_TOOLS } from '../dist/tools.js';

test('ALL_TOOLS expõe somente tools operacionais (sem analise_*)', () => {
  assert.ok(Array.isArray(ALL_TOOLS));
  assert.ok(ALL_TOOLS.length > 0);

  for (const tool of ALL_TOOLS) {
    assert.equal(tool.name.startsWith('analise_'), false, `tool indevida em ALL_TOOLS: ${tool.name}`);
    assert.ok(typeof tool.description === 'string' && tool.description.trim().length > 0);
    assert.ok(typeof tool.category === 'string' && tool.category.trim().length > 0);
    assert.ok(Array.isArray(tool.params));
  }
});

test('nomes das tools sao unicos', () => {
  const names = ALL_TOOLS.map((tool) => tool.name);
  const unique = new Set(names);
  assert.equal(unique.size, names.length, 'existem tools duplicadas em ALL_TOOLS');
});

test('ANALYSIS_TOOLS preserva tools analiticas fora da lista exposta', () => {
  assert.ok(Array.isArray(ANALYSIS_TOOLS));
  assert.ok(ANALYSIS_TOOLS.length > 0);
  assert.ok(ANALYSIS_TOOLS.every((tool) => tool.name.startsWith('analise_')));
});
