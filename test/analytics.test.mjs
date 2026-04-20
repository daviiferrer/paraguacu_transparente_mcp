import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBRL,
  formatBRL,
  summarizeDespesasPorOrgao,
  summarizeServidores,
  summarizeReceitas,
  buildRelatorioExecutivo,
} from '../dist/analytics.js';

test('parseBRL e formatBRL convertem valores monetários corretamente', () => {
  assert.equal(parseBRL('1.234.567,89'), 1234567.89);
  assert.equal(parseBRL('0,00'), 0);
  assert.equal(parseBRL(undefined), 0);
  assert.equal(parseBRL('abc'), 0);
  assert.match(formatBRL(1234.5), /^R\$ /);
});

test('summarizeDespesasPorOrgao processa todos os registros e gera alerta de execução baixa', () => {
  const data = [
    { DESCRICAO: 'Saúde', EMPENHADO: '1000,00', LIQUIDADO: '500,00', PAGO: '100,00' },
    { DESCRICAO: 'Educação', EMPENHADO: '2000,00', LIQUIDADO: '1800,00', PAGO: '200,00' },
    { DESCRICAO: 'Sem Movimento', EMPENHADO: '0,00', LIQUIDADO: '0,00', PAGO: '0,00' },
  ];
  const summary = summarizeDespesasPorOrgao(data, '2026', '01', '12');
  assert.equal(summary.dados_processados, 3);
  assert.ok(summary.markdown.includes('Resumo Geral'));
  assert.ok(summary.alertas.length >= 1);
});

test('summarizeServidores separa ativos e inativos', () => {
  const data = [
    {
      SERVIDOR: 'Carlos Daniel Viana Ferrer',
      CARGO: 'Auxiliar Administrativo',
      LOTACAO: 'Saúde',
      SITUACAOFUNCIONAL: 'ATIVO',
      VINCULO: 'Estatutário',
      TOTALPROVENTOS: '1.628,55',
      TOTALDESCONTOS: '227,99',
      LIQUIDO: '1.400,56',
      DATADESLIGAMENTO: '',
    },
    {
      SERVIDOR: 'Servidor Exonerado',
      CARGO: 'Auxiliar Operacional',
      LOTACAO: 'Educação',
      SITUACAOFUNCIONAL: 'EXONERADO',
      VINCULO: 'Estatutário',
      TOTALPROVENTOS: '1.999,47',
      TOTALDESCONTOS: '102,58',
      LIQUIDO: '1.896,89',
      DATADESLIGAMENTO: '11/02/2026',
    },
  ];
  const summary = summarizeServidores(data, '2026', '02', 10);
  assert.equal(summary.dados_processados, 2);
  assert.ok(summary.markdown.includes('Ativos: 1'));
  assert.ok(summary.markdown.includes('Inativos'));
});

test('summarizeReceitas e buildRelatorioExecutivo consolidam saída', () => {
  const receitas = summarizeReceitas(
    [
      { CODIGO: '1.1.1.1', DESCRICAO: 'Impostos', PREVISTO: '1000,00', ARRECADADO: '600,00' },
      { CODIGO: '1.1.1.2', DESCRICAO: 'Taxas', PREVISTO: '500,00', ARRECADADO: '450,00' },
    ],
    '2026',
    '01',
    '12',
  );

  const relatorio = buildRelatorioExecutivo(
    [{ titulo: 'Receitas', summary: receitas }],
    '2026',
  );

  assert.ok(relatorio.includes('2026'));
  assert.ok(relatorio.includes('registros processados'));
});
