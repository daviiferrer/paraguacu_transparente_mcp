import test from 'node:test';
import assert from 'node:assert/strict';
import { clampInt, ensureSession } from '../dist/runtime.js';

test('clampInt aplica fallback e limites', () => {
  assert.equal(clampInt(undefined, 10, 1, 20), 10);
  assert.equal(clampInt('abc', 10, 1, 20), 10);
  assert.equal(clampInt('25', 10, 1, 20), 20);
  assert.equal(clampInt('-3', 10, 1, 20), 1);
  assert.equal(clampInt('7.9', 10, 1, 20), 7);
});

test('ensureSession inicializa sessao uma vez por chave de categoria/exercicio', async () => {
  const calls = [];
  const state = {
    initializedSessions: new Map(),
    apiClient: {
      request: async (path, params) => {
        calls.push({ path, params });
        return { ok: true };
      },
    },
  };

  await ensureSession(state, 'Licitações e Contratos', '2026');
  await ensureSession(state, 'Licitações e Contratos', '2026');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/VersaoJson/LicitacoesEContratos/');
  assert.equal(calls[0].params.Listagem, 'DefineExercicio');
  assert.equal(calls[0].params.ConectarExercicio, '2026');
  assert.equal(state.initializedSessions.get('Licitações e Contratos'), '2026');
});

test('ensureSession ignora categoria sem mapeamento e nao quebra em erro', async () => {
  let called = false;
  const state1 = {
    initializedSessions: new Map(),
    apiClient: {
      request: async () => {
        called = true;
      },
    },
  };
  await ensureSession(state1, 'Diário Oficial', '2026');
  assert.equal(called, false);

  const state2 = {
    initializedSessions: new Map(),
    apiClient: {
      request: async () => {
        throw new Error('falha simulada');
      },
    },
  };

  await assert.doesNotReject(async () => {
    await ensureSession(state2, 'Despesas', '2026');
  });
});
