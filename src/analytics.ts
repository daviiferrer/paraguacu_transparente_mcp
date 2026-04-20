/**
 * Motor de Análise Inteligente para Dados Financeiros Públicos Brasileiros.
 *
 * PRINCÍPIO FUNDAMENTAL: ZERO PERDA DE DADOS.
 * - Todos os cálculos (totais, percentuais, rankings) usam 100% dos registros.
 * - Nenhum registro é descartado ou amostrado.
 * - O output é compacto (Markdown), mas os números são EXATOS.
 *
 * Fluxo: API Fiorilli → JSON bruto → analytics.ts → Markdown formatado
 */

// ═══════════════════════════════════════════════════════════════════════════════
// PARSING & FORMATAÇÃO
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Converte string monetária BR para número.
 * "1.234.567,89" → 1234567.89
 * "0,00" → 0
 * Lida com valores undefined/null/vazios → 0
 */
export function parseBRL(value: any): number {
  if (value === undefined || value === null || value === '') return 0;
  const str = String(value).trim();
  if (str === '') return 0;
  // Remove pontos de milhar, troca vírgula decimal por ponto
  const cleaned = str.replace(/\./g, '').replace(',', '.');
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

/**
 * Formata número como moeda brasileira.
 * 1234567.89 → "R$ 1.234.567,89"
 */
export function formatBRL(value: number): string {
  return 'R$ ' + value.toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Formata número compacto para tabelas.
 * 1234567.89 → "1.234.567,89" (sem R$)
 */
function fmtNum(value: number): string {
  return value.toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Calcula percentual com precisão.
 */
function pct(parte: number, total: number): string {
  if (total === 0) return '0,0%';
  return (parte / total * 100).toFixed(1).replace('.', ',') + '%';
}

// ═══════════════════════════════════════════════════════════════════════════════
// TIPOS
// ═══════════════════════════════════════════════════════════════════════════════

export interface Alert {
  nivel: 'critico' | 'atencao' | 'info';
  emoji: string;
  categoria: string;
  descricao: string;
}

export interface AnalysisSummary {
  markdown: string;
  alertas: Alert[];
  dados_processados: number; // total de registros analisados
}

// ═══════════════════════════════════════════════════════════════════════════════
// DESPESAS POR ÓRGÃO
// ═══════════════════════════════════════════════════════════════════════════════

export function summarizeDespesasPorOrgao(
  data: any[],
  exercicio: string,
  mesInicio: string,
  mesFim: string,
): AnalysisSummary {
  if (!Array.isArray(data) || data.length === 0) {
    return {
      markdown: `⚠️ Nenhum dado de despesas por órgão encontrado para ${exercicio}.`,
      alertas: [],
      dados_processados: 0,
    };
  }

  // Processa TODOS os registros
  const items = data.map(item => ({
    codigo: String(item.CODIGO || item.Codigo || ''),
    nome: String(item.DESCRICAO || item.Descricao || item.ORGAO || 'Sem nome'),
    empenhado: parseBRL(item.EMPENHADO || item.Empenhado),
    liquidado: parseBRL(item.LIQUIDADO || item.Liquidado),
    pago: parseBRL(item.PAGO || item.Pago),
  }));

  // Totais calculados sobre 100% dos registros
  let totalEmpenhado = 0;
  let totalLiquidado = 0;
  let totalPago = 0;
  for (const it of items) {
    totalEmpenhado += it.empenhado;
    totalLiquidado += it.liquidado;
    totalPago += it.pago;
  }

  // Ordena por empenhado decrescente
  items.sort((a, b) => b.empenhado - a.empenhado);

  // Alertas
  const alertas: Alert[] = [];

  // Execução orçamentária
  const execucao = totalEmpenhado > 0 ? (totalPago / totalEmpenhado) * 100 : 0;
  if (execucao < 50) {
    alertas.push({
      nivel: 'atencao', emoji: '⚠️', categoria: 'Execução',
      descricao: `Execução orçamentária baixa: ${execucao.toFixed(1)}% (pago/empenhado)`,
    });
  }

  // Órgão com valor zerado
  const zerados = items.filter(it => it.empenhado === 0 && it.liquidado === 0);
  if (zerados.length > 0) {
    alertas.push({
      nivel: 'info', emoji: 'ℹ️', categoria: 'Órgãos Inativos',
      descricao: `${zerados.length} órgão(s) sem movimentação no período`,
    });
  }

  // Concentração (top 3)
  const top3sum = items.slice(0, 3).reduce((s, it) => s + it.empenhado, 0);
  const concTop3 = totalEmpenhado > 0 ? (top3sum / totalEmpenhado) * 100 : 0;
  if (concTop3 > 70) {
    alertas.push({
      nivel: 'atencao', emoji: '⚠️', categoria: 'Concentração',
      descricao: `Top 3 órgãos concentram ${concTop3.toFixed(1)}% do total empenhado`,
    });
  }

  // Monta Markdown — TODOS os órgãos na tabela
  const periodo = mesInicio === '01' && mesFim === '12' ? `${exercicio} (Ano Completo)` : `${exercicio} (${mesInicio}-${mesFim})`;

  let md = `📊 **Despesas por Órgão — Paraguaçu Paulista ${periodo}**\n`;
  md += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
  md += `📈 **Resumo Geral** (${items.length} órgãos)\n`;
  md += `• Empenhado: ${formatBRL(totalEmpenhado)}\n`;
  md += `• Liquidado: ${formatBRL(totalLiquidado)}\n`;
  md += `• Pago: ${formatBRL(totalPago)}\n`;
  md += `• Execução (Pago/Empenh): ${execucao.toFixed(1)}%\n\n`;

  md += `| # | Órgão | Empenhado | Liquidado | Pago | % Total |\n`;
  md += `|---|---|---|---|---|---|\n`;
  items.forEach((it, idx) => {
    if (it.empenhado > 0 || it.liquidado > 0 || it.pago > 0) {
      md += `| ${idx + 1} | ${it.nome} | ${fmtNum(it.empenhado)} | ${fmtNum(it.liquidado)} | ${fmtNum(it.pago)} | ${pct(it.empenhado, totalEmpenhado)} |\n`;
    }
  });

  if (zerados.length > 0) {
    md += `\n*${zerados.length} órgão(s) sem movimentação omitidos da tabela.*\n`;
  }

  if (alertas.length > 0) {
    md += `\n🚨 **Alertas** (${alertas.length})\n`;
    for (const a of alertas) {
      md += `${a.emoji} **${a.categoria}**: ${a.descricao}\n`;
    }
  }

  return { markdown: md, alertas, dados_processados: data.length };
}

// ═══════════════════════════════════════════════════════════════════════════════
// DESPESAS POR FORNECEDOR
// ═══════════════════════════════════════════════════════════════════════════════

export function summarizeDespesasPorFornecedor(
  data: any[],
  exercicio: string,
  mesInicio: string,
  mesFim: string,
  topN: number = 30,
): AnalysisSummary {
  if (!Array.isArray(data) || data.length === 0) {
    return {
      markdown: `⚠️ Nenhum dado de fornecedores encontrado para ${exercicio}.`,
      alertas: [],
      dados_processados: 0,
    };
  }

  const items = data.map(item => ({
    nome: String(item.NOMEFAVORECIDO || item.NomeFavorecido || item.FAVORECIDO || 'Sem nome').trim(),
    cnpj: String(item.CNPJFAVORECIDO || item.CnpjFavorecido || item.CNPJ || '').trim(),
    empenhado: parseBRL(item.EMPENHADO || item.Empenhado),
    liquidado: parseBRL(item.LIQUIDADO || item.Liquidado),
    pago: parseBRL(item.PAGO || item.Pago),
  }));

  // Totais sobre 100% dos registros
  let totalEmpenhado = 0;
  let totalLiquidado = 0;
  let totalPago = 0;
  for (const it of items) {
    totalEmpenhado += it.empenhado;
    totalLiquidado += it.liquidado;
    totalPago += it.pago;
  }

  items.sort((a, b) => b.empenhado - a.empenhado);

  const alertas: Alert[] = [];

  // Concentração top 5
  const top5sum = items.slice(0, 5).reduce((s, it) => s + it.empenhado, 0);
  const concTop5 = totalEmpenhado > 0 ? (top5sum / totalEmpenhado) * 100 : 0;
  if (concTop5 > 50) {
    alertas.push({
      nivel: 'critico', emoji: '🔴', categoria: 'Concentração',
      descricao: `Top 5 fornecedores concentram ${concTop5.toFixed(1)}% do empenhado total`,
    });
  }

  // Fornecedor individual >20%
  for (const it of items) {
    const pctVal = totalEmpenhado > 0 ? (it.empenhado / totalEmpenhado) * 100 : 0;
    if (pctVal > 20) {
      alertas.push({
        nivel: 'critico', emoji: '🔴', categoria: 'Concentração Individual',
        descricao: `"${it.nome}" (${it.cnpj || 'sem CNPJ'}) concentra ${pctVal.toFixed(1)}% do total (${formatBRL(it.empenhado)})`,
      });
    }
  }

  // Fornecedores com empenhado alto e pago zero (possível irregularidade)
  const empNaoPago = items.filter(it => it.empenhado > 100000 && it.pago === 0);
  if (empNaoPago.length > 0) {
    alertas.push({
      nivel: 'atencao', emoji: '⚠️', categoria: 'Empenho sem Pagamento',
      descricao: `${empNaoPago.length} fornecedor(es) com empenho >R$100k e pagamento zero`,
    });
  }

  // Markdown — Top N + resumo dos demais
  const periodo = mesInicio === '01' && mesFim === '12' ? `${exercicio} (Ano Completo)` : `${exercicio} (${mesInicio}-${mesFim})`;

  let md = `📊 **Fornecedores — Paraguaçu Paulista ${periodo}**\n`;
  md += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
  md += `📈 **Resumo Geral** (${items.length} fornecedores — dados 100% processados)\n`;
  md += `• Empenhado Total: ${formatBRL(totalEmpenhado)}\n`;
  md += `• Liquidado Total: ${formatBRL(totalLiquidado)}\n`;
  md += `• Pago Total: ${formatBRL(totalPago)}\n\n`;

  const showItems = items.filter(it => it.empenhado > 0 || it.pago > 0);
  const displayCount = Math.min(topN, showItems.length);

  md += `🏆 **Top ${displayCount} Fornecedores** (Empenhado)\n`;
  md += `| # | Fornecedor | CNPJ | Empenhado | Pago | % Total |\n`;
  md += `|---|---|---|---|---|---|\n`;
  for (let i = 0; i < displayCount; i++) {
    const it = showItems[i];
    md += `| ${i + 1} | ${it.nome} | ${it.cnpj || '-'} | ${fmtNum(it.empenhado)} | ${fmtNum(it.pago)} | ${pct(it.empenhado, totalEmpenhado)} |\n`;
  }

  if (showItems.length > topN) {
    const restantes = showItems.slice(topN);
    const restEmp = restantes.reduce((s, it) => s + it.empenhado, 0);
    const restPago = restantes.reduce((s, it) => s + it.pago, 0);
    md += `| — | *Demais ${restantes.length} fornecedores* | — | ${fmtNum(restEmp)} | ${fmtNum(restPago)} | ${pct(restEmp, totalEmpenhado)} |\n`;
  }

  if (alertas.length > 0) {
    md += `\n🚨 **Alertas** (${alertas.length})\n`;
    for (const a of alertas) {
      md += `${a.emoji} **${a.categoria}**: ${a.descricao}\n`;
    }
  }

  return { markdown: md, alertas, dados_processados: data.length };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVIDORES / PESSOAL
// ═══════════════════════════════════════════════════════════════════════════════

export function summarizeServidores(
  data: any[],
  exercicio: string,
  mes: string,
  topN: number = 20,
): AnalysisSummary {
  if (!Array.isArray(data) || data.length === 0) {
    return {
      markdown: `⚠️ Nenhum dado de servidores encontrado para ${exercicio}/${mes}.`,
      alertas: [],
      dados_processados: 0,
    };
  }

  const items = data.map(item => ({
    nome: String(item.SERVIDOR || item.Nome || item.NOME || '').trim(),
    cargo: String(item.CARGO || item.Cargo || '').trim(),
    lotacao: String(item.LOTACAO || item.Lotacao || '').trim(),
    situacao: String(item.SITUACAOFUNCIONAL || item.SituacaoFuncional || item.SITUACAO || 'ATIVO').trim().toUpperCase(),
    vinculo: String(item.VINCULO || item.Vinculo || '').trim(),
    dataAdmissao: String(item.DATAADMISSAO || item.DataAdmissao || '').trim(),
    dataDesligamento: String(item.DATADESLIGAMENTO || item.DataDesligamento || '').trim(),
    bruto: parseBRL(item.TOTALPROVENTOS || item.TotalProventos || item.BRUTO || item.PROVENTOS),
    descontos: parseBRL(item.TOTALDESCONTOS || item.TotalDescontos || item.DESCONTOS),
    liquido: parseBRL(item.LIQUIDO || item.Liquido || item.SALARIOLIQUIDO),
  }));

  // Separar ativos vs demitidos/exonerados
  const ativos = items.filter(it =>
    !it.situacao.includes('DEMITID') &&
    !it.situacao.includes('EXONERAD') &&
    !it.situacao.includes('RESCINDID') &&
    !it.situacao.includes('FALECID') &&
    it.dataDesligamento === ''
  );
  const inativos = items.filter(it =>
    it.situacao.includes('DEMITID') ||
    it.situacao.includes('EXONERAD') ||
    it.situacao.includes('RESCINDID') ||
    it.situacao.includes('FALECID') ||
    (it.dataDesligamento !== '' && it.dataDesligamento !== '0' && it.dataDesligamento !== '01/01/0001')
  );

  // Totais sobre 100% dos ativos
  let totalBruto = 0;
  let totalDescontos = 0;
  let totalLiquido = 0;
  for (const it of ativos) {
    totalBruto += it.bruto;
    totalDescontos += it.descontos;
    totalLiquido += it.liquido;
  }

  // Top salários (ativos)
  const ativosOrdenados = [...ativos].sort((a, b) => b.bruto - a.bruto);
  const mediaBruto = ativos.length > 0 ? totalBruto / ativos.length : 0;

  const alertas: Alert[] = [];

  // Servidor acima de R$30k
  const acimaTeto = ativos.filter(it => it.bruto > 30000);
  if (acimaTeto.length > 0) {
    for (const s of acimaTeto) {
      alertas.push({
        nivel: 'critico', emoji: '🔴', categoria: 'Salário Elevado',
        descricao: `"${s.nome}" (${s.cargo}) — Bruto: ${formatBRL(s.bruto)} — acima de R$30k/mês`,
      });
    }
  }

  // Servidor acima de 3x a média
  const limiteAnomalia = mediaBruto * 3;
  const anomalos = ativos.filter(it => it.bruto > limiteAnomalia && it.bruto <= 30000);
  if (anomalos.length > 0) {
    alertas.push({
      nivel: 'atencao', emoji: '⚠️', categoria: 'Salário Desproporcional',
      descricao: `${anomalos.length} servidor(es) com salário >3x a média (média: ${formatBRL(mediaBruto)})`,
    });
  }

  // Markdown
  let md = `👥 **Servidores — Paraguaçu Paulista ${exercicio} (Ref: mês ${mes})**\n`;
  md += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
  md += `📈 **Resumo Geral** (${items.length} registros — 100% processados)\n`;
  md += `• Total registros na folha: ${items.length}\n`;
  md += `• Ativos: ${ativos.length}\n`;
  md += `• Inativos/Demitidos/Exonerados: ${inativos.length}\n`;
  md += `• Folha Bruta (ativos): ${formatBRL(totalBruto)}\n`;
  md += `• Descontos: ${formatBRL(totalDescontos)}\n`;
  md += `• Folha Líquida (ativos): ${formatBRL(totalLiquido)}\n`;
  md += `• Média salarial bruta: ${formatBRL(mediaBruto)}\n\n`;

  // Top salários
  const showTop = Math.min(topN, ativosOrdenados.length);
  md += `🏆 **Top ${showTop} Maiores Salários (Ativos)**\n`;
  md += `| # | Servidor | Cargo | Lotação | Bruto | Líquido |\n`;
  md += `|---|---|---|---|---|---|\n`;
  for (let i = 0; i < showTop; i++) {
    const it = ativosOrdenados[i];
    md += `| ${i + 1} | ${it.nome} | ${it.cargo} | ${it.lotacao} | ${fmtNum(it.bruto)} | ${fmtNum(it.liquido)} |\n`;
  }

  // Demitidos/Exonerados
  if (inativos.length > 0) {
    md += `\n📋 **Servidores Inativos/Demitidos/Exonerados** (${inativos.length})\n`;
    md += `| Servidor | Cargo | Situação | Data Desligamento | Último Bruto |\n`;
    md += `|---|---|---|---|---|\n`;
    for (const it of inativos) {
      md += `| ${it.nome} | ${it.cargo} | ${it.situacao} | ${it.dataDesligamento || '-'} | ${fmtNum(it.bruto)} |\n`;
    }
  }

  // Distribuição por vínculo
  const vinculos = new Map<string, { qtd: number; totalBruto: number }>();
  for (const it of ativos) {
    const v = it.vinculo || 'Não informado';
    const entry = vinculos.get(v) || { qtd: 0, totalBruto: 0 };
    entry.qtd++;
    entry.totalBruto += it.bruto;
    vinculos.set(v, entry);
  }
  if (vinculos.size > 0) {
    md += `\n📊 **Distribuição por Vínculo (Ativos)**\n`;
    md += `| Vínculo | Qtd | Total Bruto | Média |\n`;
    md += `|---|---|---|---|\n`;
    const vinculosSorted = [...vinculos.entries()].sort((a, b) => b[1].totalBruto - a[1].totalBruto);
    for (const [v, info] of vinculosSorted) {
      const media = info.qtd > 0 ? info.totalBruto / info.qtd : 0;
      md += `| ${v} | ${info.qtd} | ${fmtNum(info.totalBruto)} | ${fmtNum(media)} |\n`;
    }
  }

  if (alertas.length > 0) {
    md += `\n🚨 **Alertas** (${alertas.length})\n`;
    for (const a of alertas) {
      md += `${a.emoji} **${a.categoria}**: ${a.descricao}\n`;
    }
  }

  return { markdown: md, alertas, dados_processados: data.length };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LICITAÇÕES
// ═══════════════════════════════════════════════════════════════════════════════

export function summarizeLicitacoes(
  data: any[],
  exercicio: string,
): AnalysisSummary {
  if (!Array.isArray(data) || data.length === 0) {
    return {
      markdown: `⚠️ Nenhuma licitação encontrada para ${exercicio}.`,
      alertas: [],
      dados_processados: 0,
    };
  }

  const items = data.map(item => ({
    numero: String(item.NUMERO || item.Numero || item.NUM_LICITACAO || ''),
    modalidade: String(item.MODALIDADE || item.Modalidade || '').trim(),
    objeto: String(item.OBJETO || item.Objeto || '').trim(),
    valor: parseBRL(item.VALOR || item.Valor || item.VALORESTIMADO || item.VALORLICITACAO),
    dataAbertura: String(item.DATAABERTURA || item.DataAbertura || '').trim(),
    situacao: String(item.SITUACAO || item.Situacao || '').trim(),
    fornecedor: String(item.FORNECEDOR || item.Fornecedor || item.VENCEDOR || '').trim(),
  }));

  // Agrupa por modalidade
  const porModalidade = new Map<string, { qtd: number; valorTotal: number }>();
  let totalValor = 0;

  for (const it of items) {
    totalValor += it.valor;
    const mod = it.modalidade || 'Não informada';
    const entry = porModalidade.get(mod) || { qtd: 0, valorTotal: 0 };
    entry.qtd++;
    entry.valorTotal += it.valor;
    porModalidade.set(mod, entry);
  }

  // Conta dispensas e inexigibilidades
  const dispensas = items.filter(it =>
    it.modalidade.toUpperCase().includes('DISPENSA')
  );
  const inexigibilidades = items.filter(it =>
    it.modalidade.toUpperCase().includes('INEXIG')
  );

  const alertas: Alert[] = [];

  // Muitas dispensas
  const pctDispensas = items.length > 0 ? (dispensas.length / items.length) * 100 : 0;
  if (pctDispensas > 40) {
    alertas.push({
      nivel: 'critico', emoji: '🔴', categoria: 'Alto Volume de Dispensas',
      descricao: `${dispensas.length} dispensas de licitação (${pctDispensas.toFixed(1)}% do total)`,
    });
  } else if (pctDispensas > 25) {
    alertas.push({
      nivel: 'atencao', emoji: '⚠️', categoria: 'Volume de Dispensas',
      descricao: `${dispensas.length} dispensas de licitação (${pctDispensas.toFixed(1)}% do total)`,
    });
  }

  // Dispensa de alto valor
  const dispensasAltas = dispensas.filter(it => it.valor > 100000);
  for (const d of dispensasAltas) {
    alertas.push({
      nivel: 'critico', emoji: '🔴', categoria: 'Dispensa Alto Valor',
      descricao: `Dispensa nº ${d.numero}: ${formatBRL(d.valor)} — "${d.objeto.substring(0, 80)}"`,
    });
  }

  // Objeto vago
  const objVagos = items.filter(it =>
    it.objeto.length < 15 || it.objeto.toUpperCase().includes('DIVERSOS')
  );
  if (objVagos.length > 0) {
    alertas.push({
      nivel: 'atencao', emoji: '⚠️', categoria: 'Objeto Vago',
      descricao: `${objVagos.length} licitação(ões) com objeto muito curto ou genérico`,
    });
  }

  // Markdown
  let md = `📋 **Licitações — Paraguaçu Paulista ${exercicio}**\n`;
  md += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
  md += `📈 **Resumo Geral** (${items.length} processos — 100% processados)\n`;
  md += `• Total de processos: ${items.length}\n`;
  md += `• Valor total estimado: ${formatBRL(totalValor)}\n`;
  md += `• Dispensas: ${dispensas.length} (${pctDispensas.toFixed(1)}%)\n`;
  md += `• Inexigibilidades: ${inexigibilidades.length}\n\n`;

  // Por modalidade
  md += `📊 **Por Modalidade**\n`;
  md += `| Modalidade | Qtd | Valor Total | % Qtd |\n`;
  md += `|---|---|---|---|\n`;
  const modSorted = [...porModalidade.entries()].sort((a, b) => b[1].qtd - a[1].qtd);
  for (const [mod, info] of modSorted) {
    md += `| ${mod} | ${info.qtd} | ${fmtNum(info.valorTotal)} | ${pct(info.qtd, items.length)} |\n`;
  }

  // Maiores licitações
  const topLicit = [...items].sort((a, b) => b.valor - a.valor).slice(0, 15);
  md += `\n🏆 **Top 15 Maiores Licitações (Valor)**\n`;
  md += `| # | Nº | Modalidade | Objeto | Valor | Situação |\n`;
  md += `|---|---|---|---|---|---|\n`;
  topLicit.forEach((it, idx) => {
    const objShort = it.objeto.length > 60 ? it.objeto.substring(0, 60) + '...' : it.objeto;
    md += `| ${idx + 1} | ${it.numero} | ${it.modalidade} | ${objShort} | ${fmtNum(it.valor)} | ${it.situacao} |\n`;
  });

  if (alertas.length > 0) {
    md += `\n🚨 **Alertas** (${alertas.length})\n`;
    for (const a of alertas) {
      md += `${a.emoji} **${a.categoria}**: ${a.descricao}\n`;
    }
  }

  return { markdown: md, alertas, dados_processados: data.length };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONTRATOS
// ═══════════════════════════════════════════════════════════════════════════════

export function summarizeContratos(
  data: any[],
  exercicio: string,
): AnalysisSummary {
  if (!Array.isArray(data) || data.length === 0) {
    return {
      markdown: `⚠️ Nenhum contrato encontrado para ${exercicio}.`,
      alertas: [],
      dados_processados: 0,
    };
  }

  const items = data.map(item => ({
    numero: String(item.NUMERO || item.Numero || item.NUMCONTRATO || ''),
    fornecedor: String(item.FORNECEDOR || item.Fornecedor || item.CONTRATADO || item.RAZAOSOCIAL || '').trim(),
    cnpj: String(item.CNPJ || item.Cnpj || item.CNPJCONTRATADO || '').trim(),
    objeto: String(item.OBJETO || item.Objeto || '').trim(),
    valor: parseBRL(item.VALOR || item.Valor || item.VALORCONTRATADO || item.VALORCONTRATO),
    dataInicio: String(item.DATAINICIO || item.DataInicio || item.DATACONTRATO || '').trim(),
    dataFim: String(item.DATAFIM || item.DataFim || item.DATAVENCIMENTO || '').trim(),
    modalidade: String(item.MODALIDADE || item.Modalidade || '').trim(),
  }));

  let totalValor = 0;
  for (const it of items) {
    totalValor += it.valor;
  }

  items.sort((a, b) => b.valor - a.valor);

  const alertas: Alert[] = [];

  // Fornecedores com múltiplos contratos
  const contratosFor = new Map<string, number>();
  for (const it of items) {
    const key = it.fornecedor || it.cnpj;
    contratosFor.set(key, (contratosFor.get(key) || 0) + 1);
  }
  const recorrentes = [...contratosFor.entries()].filter(([_, cnt]) => cnt >= 3);
  for (const [forn, cnt] of recorrentes) {
    alertas.push({
      nivel: 'atencao', emoji: '⚠️', categoria: 'Fornecedor Recorrente',
      descricao: `"${forn}" possui ${cnt} contratos no exercício`,
    });
  }

  // Contratos de alto valor
  const altosValores = items.filter(it => it.valor > 1000000);
  if (altosValores.length > 0) {
    alertas.push({
      nivel: 'info', emoji: 'ℹ️', categoria: 'Alto Valor',
      descricao: `${altosValores.length} contrato(s) acima de R$ 1 milhão`,
    });
  }

  let md = `📝 **Contratos — Paraguaçu Paulista ${exercicio}**\n`;
  md += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
  md += `📈 **Resumo Geral** (${items.length} contratos — 100% processados)\n`;
  md += `• Total de contratos: ${items.length}\n`;
  md += `• Valor total: ${formatBRL(totalValor)}\n`;
  md += `• Fornecedores recorrentes (3+ contratos): ${recorrentes.length}\n\n`;

  // Todos os contratos (compacto)
  md += `📋 **Contratos** (ordenados por valor)\n`;
  md += `| # | Nº | Fornecedor | Objeto | Valor | Vigência |\n`;
  md += `|---|---|---|---|---|---|\n`;
  items.forEach((it, idx) => {
    const objShort = it.objeto.length > 50 ? it.objeto.substring(0, 50) + '...' : it.objeto;
    const vigencia = it.dataInicio && it.dataFim ? `${it.dataInicio} a ${it.dataFim}` : it.dataInicio || '-';
    md += `| ${idx + 1} | ${it.numero} | ${it.fornecedor} | ${objShort} | ${fmtNum(it.valor)} | ${vigencia} |\n`;
  });

  if (alertas.length > 0) {
    md += `\n🚨 **Alertas** (${alertas.length})\n`;
    for (const a of alertas) {
      md += `${a.emoji} **${a.categoria}**: ${a.descricao}\n`;
    }
  }

  return { markdown: md, alertas, dados_processados: data.length };
}

// ═══════════════════════════════════════════════════════════════════════════════
// RECEITAS
// ═══════════════════════════════════════════════════════════════════════════════

export function summarizeReceitas(
  data: any[],
  exercicio: string,
  mesInicio: string,
  mesFim: string,
): AnalysisSummary {
  if (!Array.isArray(data) || data.length === 0) {
    return {
      markdown: `⚠️ Nenhum dado de receitas encontrado para ${exercicio}.`,
      alertas: [],
      dados_processados: 0,
    };
  }

  const items = data.map(item => ({
    codigo: String(item.CODIGO || item.Codigo || item.CODIGORECEITA || ''),
    descricao: String(item.DESCRICAO || item.Descricao || item.RECEITA || '').trim(),
    previsto: parseBRL(item.PREVISTO || item.Previsto || item.PREVISAOINICIAL),
    arrecadado: parseBRL(item.ARRECADADO || item.Arrecadado || item.RECEITAREALIZADA),
  }));

  let totalPrevisto = 0;
  let totalArrecadado = 0;
  for (const it of items) {
    totalPrevisto += it.previsto;
    totalArrecadado += it.arrecadado;
  }

  const execucaoReceita = totalPrevisto > 0 ? (totalArrecadado / totalPrevisto) * 100 : 0;

  items.sort((a, b) => b.arrecadado - a.arrecadado);

  const alertas: Alert[] = [];

  // Arrecadação muito abaixo do previsto
  if (execucaoReceita < 70) {
    alertas.push({
      nivel: 'critico', emoji: '🔴', categoria: 'Arrecadação Baixa',
      descricao: `Arrecadação atingiu apenas ${execucaoReceita.toFixed(1)}% do previsto`,
    });
  } else if (execucaoReceita < 85) {
    alertas.push({
      nivel: 'atencao', emoji: '⚠️', categoria: 'Arrecadação Abaixo',
      descricao: `Arrecadação em ${execucaoReceita.toFixed(1)}% do previsto`,
    });
  }

  // Receitas com arrecadação >150% do previsto (possível erro ou evento atípico)
  const superArrecadado = items.filter(it => it.previsto > 0 && it.arrecadado > it.previsto * 1.5);
  if (superArrecadado.length > 0) {
    alertas.push({
      nivel: 'atencao', emoji: '⚠️', categoria: 'Super-Arrecadação',
      descricao: `${superArrecadado.length} receita(s) arrecadaram >150% do previsto`,
    });
  }

  const periodo = mesInicio === '01' && mesFim === '12' ? `${exercicio} (Ano Completo)` : `${exercicio} (${mesInicio}-${mesFim})`;

  let md = `💰 **Receitas — Paraguaçu Paulista ${periodo}**\n`;
  md += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
  md += `📈 **Resumo Geral** (${items.length} fontes — 100% processadas)\n`;
  md += `• Previsto: ${formatBRL(totalPrevisto)}\n`;
  md += `• Arrecadado: ${formatBRL(totalArrecadado)}\n`;
  md += `• Execução: ${execucaoReceita.toFixed(1)}%\n`;
  md += `• Diferença: ${formatBRL(totalArrecadado - totalPrevisto)}\n\n`;

  // Todas as receitas com valor
  const comValor = items.filter(it => it.previsto > 0 || it.arrecadado > 0);
  md += `📊 **Receitas por Fonte** (${comValor.length} com movimentação)\n`;
  md += `| # | Código | Descrição | Previsto | Arrecadado | Exec% |\n`;
  md += `|---|---|---|---|---|---|\n`;
  comValor.forEach((it, idx) => {
    const exec = it.previsto > 0 ? (it.arrecadado / it.previsto * 100).toFixed(1) + '%' : '-';
    const descShort = it.descricao.length > 45 ? it.descricao.substring(0, 45) + '...' : it.descricao;
    md += `| ${idx + 1} | ${it.codigo} | ${descShort} | ${fmtNum(it.previsto)} | ${fmtNum(it.arrecadado)} | ${exec} |\n`;
  });

  if (alertas.length > 0) {
    md += `\n🚨 **Alertas** (${alertas.length})\n`;
    for (const a of alertas) {
      md += `${a.emoji} **${a.categoria}**: ${a.descricao}\n`;
    }
  }

  return { markdown: md, alertas, dados_processados: data.length };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ANÁLISE COMPLETA (RELATÓRIO EXECUTIVO)
// ═══════════════════════════════════════════════════════════════════════════════

export function buildRelatorioExecutivo(
  parts: { titulo: string; summary: AnalysisSummary }[],
  exercicio: string,
): string {
  let allAlertas: Alert[] = [];
  let totalRegistros = 0;

  for (const p of parts) {
    allAlertas = allAlertas.concat(p.summary.alertas);
    totalRegistros += p.summary.dados_processados;
  }

  const criticos = allAlertas.filter(a => a.nivel === 'critico');
  const atencao = allAlertas.filter(a => a.nivel === 'atencao');
  const info = allAlertas.filter(a => a.nivel === 'info');

  let md = `🏛️ **RELATÓRIO DE ANÁLISE — PARAGUAÇU PAULISTA ${exercicio}**\n`;
  md += `══════════════════════════════════════════════════════════\n`;
  md += `*Gerado por MCP Portal Transparência — ${new Date().toLocaleDateString('pt-BR')}*\n\n`;
  md += `📊 **Resumo**: ${totalRegistros.toLocaleString('pt-BR')} registros processados | ${allAlertas.length} alertas\n`;
  md += `• 🔴 Críticos: ${criticos.length}\n`;
  md += `• ⚠️ Atenção: ${atencao.length}\n`;
  md += `• ℹ️ Informativos: ${info.length}\n\n`;

  if (criticos.length > 0) {
    md += `🚨 **ALERTAS CRÍTICOS**\n`;
    for (const a of criticos) {
      md += `${a.emoji} [${a.categoria}] ${a.descricao}\n`;
    }
    md += `\n`;
  }

  if (atencao.length > 0) {
    md += `⚠️ **PONTOS DE ATENÇÃO**\n`;
    for (const a of atencao) {
      md += `${a.emoji} [${a.categoria}] ${a.descricao}\n`;
    }
    md += `\n`;
  }

  md += `───────────────────────────────────────────────\n\n`;

  // Seções individuais
  for (const p of parts) {
    md += p.summary.markdown;
    md += `\n───────────────────────────────────────────────\n\n`;
  }

  return md;
}
