/**
 * Definições de todas as ferramentas (tools) MCP mapeadas a partir da
 * documentação "Dados Abertos" do Portal Transparência Fiorilli.
 *
 * Cada definição contém:
 *  - name: nome único da tool (prefixo fiorilli_)
 *  - description: descrição em pt-BR para o LLM
 *  - category: agrupamento lógico
 *  - path: caminho base da API (ex: /VersaoJson/Despesas/)
 *  - listagem: valor do parâmetro Listagem
 *  - params: parâmetros aceitos com tipo, obrigatoriedade e descrição
 */

export interface ParamDef {
  name: string;
  description: string;
  type: 'string' | 'number' | 'boolean';
  required: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  category: string;
  path: string;
  listagem: string;
  params: ParamDef[];
}

// ─── Parâmetros reutilizáveis ────────────────────────────────────────────────

const P_EXERCICIO: ParamDef = {
  name: 'Exercicio',
  description: 'Ano do exercício fiscal (ex: 2024)',
  type: 'string',
  required: true,
};

const P_EMPRESA: ParamDef = {
  name: 'Empresa',
  description: 'ID da entidade/empresa (1 = Prefeitura principal)',
  type: 'string',
  required: true,
};

const P_DIA_INICIO: ParamDef = {
  name: 'DiaInicioPeriodo',
  description: 'Dia de início do período (01-31)',
  type: 'string',
  required: true,
};

const P_MES_INICIO: ParamDef = {
  name: 'MesInicialPeriodo',
  description: 'Mês de início do período (01-12)',
  type: 'string',
  required: true,
};

const P_DIA_FINAL: ParamDef = {
  name: 'DiaFinalPeriodo',
  description: 'Dia final do período (01-31)',
  type: 'string',
  required: true,
};

const P_MES_FINAL: ParamDef = {
  name: 'MesFinalPeriodo',
  description: 'Mês final do período (01-12)',
  type: 'string',
  required: true,
};

const P_CONSOLIDADO: ParamDef = {
  name: 'MostraDadosConsolidado',
  description: 'Mostrar dados consolidados de todas as entidades (True/False)',
  type: 'string',
  required: false,
};

const P_MOSTRAR_FORNECEDOR: ParamDef = {
  name: 'MostrarFornecedor',
  description: 'Exibir nome do favorecido/fornecedor (True/False)',
  type: 'string',
  required: false,
};

const P_NUM_EMPENHO: ParamDef = {
  name: 'intNumeroEmpenho',
  description: 'Número do empenho',
  type: 'string',
  required: true,
};

const P_TIPO_EMPENHO: ParamDef = {
  name: 'strTipoEmpenho',
  description: 'Tipo do empenho (OR=Ordinário, GL=Global, ES=Estimativo)',
  type: 'string',
  required: true,
};

const P_APRESENTA_FAVORECIDO: ParamDef = {
  name: 'ApresentaNomeFavorecido',
  description: 'Exibir nome do favorecido (True/False)',
  type: 'string',
  required: false,
};

// Conjunto de parâmetros de período completo
const PARAMS_PERIODO: ParamDef[] = [
  P_DIA_INICIO,
  P_MES_INICIO,
  P_DIA_FINAL,
  P_MES_FINAL,
  P_EXERCICIO,
  P_EMPRESA,
  P_CONSOLIDADO,
];

// Conjunto de parâmetros para consultas por número de empenho com período
const PARAMS_EMPENHO_PERIODO: ParamDef[] = [
  P_NUM_EMPENHO,
  P_TIPO_EMPENHO,
  P_DIA_INICIO,
  P_MES_INICIO,
  P_DIA_FINAL,
  P_MES_FINAL,
  P_EXERCICIO,
  P_EMPRESA,
  {
    name: 'IDButton',
    description: 'Tipo de listagem (ex: lnkDespesasPor_NotaEmpenho)',
    type: 'string',
    required: false,
  },
  P_MOSTRAR_FORNECEDOR,
  P_CONSOLIDADO,
];

// ─── DESPESAS ────────────────────────────────────────────────────────────────

const DESPESAS_PATH = '/VersaoJson/Despesas/';

const despesasTools: ToolDef[] = [
  {
    name: 'despesas_definir_exercicio',
    description:
      'Define o exercício fiscal (ano) para consultas de despesas. Deve ser chamado antes de outras consultas de despesas.',
    category: 'Despesas',
    path: DESPESAS_PATH,
    listagem: 'DefineExercicio',
    params: [
      {
        name: 'ConectarExercicio',
        description: 'Ano do exercício a definir (ex: 2024)',
        type: 'string',
        required: true,
      },
    ],
  },
  {
    name: 'despesas_por_orgao',
    description:
      'Lista despesas agrupadas por órgão/departamento municipal (Gabinete, Educação, Saúde, etc). Retorna valores empenhado, liquidado e pago por órgão.',
    category: 'Despesas',
    path: DESPESAS_PATH,
    listagem: 'DespesasPorOrgao',
    params: [...PARAMS_PERIODO],
  },
  {
    name: 'despesas_por_unidade',
    description:
      'Lista despesas agrupadas por unidade gestora. Retorna valores empenhado, liquidado e pago por unidade.',
    category: 'Despesas',
    path: DESPESAS_PATH,
    listagem: 'DespesasPorUnidade',
    params: [...PARAMS_PERIODO],
  },
  {
    name: 'despesas_por_fornecedor',
    description:
      'Lista despesas agrupadas por fornecedor/favorecido. Permite filtrar por CNPJ específico. Retorna valores empenhado, liquidado e pago.',
    category: 'Despesas',
    path: DESPESAS_PATH,
    listagem: 'DespesasPorFornecedor',
    params: [
      ...PARAMS_PERIODO,
      P_MOSTRAR_FORNECEDOR,
      {
        name: 'CNPJFornecedor',
        description: 'CNPJ de um fornecedor específico (opcional, filtra resultados)',
        type: 'string',
        required: false,
      },
    ],
  },
  {
    name: 'despesas_gerais',
    description:
      'Lista detalhada das despesas/empenhos usando a própria tela oficial do portal (DespesasPorEntidade.aspx), inclusive quando a rota VersaoJson/DespesasGerais estiver quebrada. Retorna empenho, fornecedor, CPF/CNPJ, dotação, valores, função, subfunção, fonte, natureza e licitação.',
    category: 'Despesas',
    path: DESPESAS_PATH,
    listagem: 'DespesasGerais',
    params: [
      ...PARAMS_PERIODO,
      P_MOSTRAR_FORNECEDOR,
      {
        name: 'UFParaFiltroCOVID',
        description: 'UF para filtrar empenhos relacionados à COVID (opcional)',
        type: 'string',
        required: false,
      },
      {
        name: 'MostrarCNPJFornecedor',
        description: 'Exibir CNPJ do fornecedor nos resultados (True/False)',
        type: 'string',
        required: false,
      },
      {
        name: 'ApenasIDEmpenho',
        description: 'Listar apenas os códigos de empenho sem detalhes (True/False)',
        type: 'string',
        required: false,
      },
    ],
  },
  {
    name: 'despesas_detalhe_empenho',
    description:
      'Retorna detalhes completos de um empenho específico pelo seu número e tipo.',
    category: 'Despesas',
    path: DESPESAS_PATH,
    listagem: 'DetalhesEmpenhoPorNumeroEmpenho',
    params: [
      P_NUM_EMPENHO,
      P_TIPO_EMPENHO,
      P_EMPRESA,
      {
        name: 'bolMostrarFornecedor',
        description: 'Exibir nome do fornecedor (True/False)',
        type: 'string',
        required: false,
      },
    ],
  },
  {
    name: 'despesas_itens_empenho',
    description:
      'Lista os itens (produtos/serviços) de um empenho específico pelo seu número.',
    category: 'Despesas',
    path: DESPESAS_PATH,
    listagem: 'ItensEmpenhoPorNumeroEmpenho',
    params: [P_NUM_EMPENHO, P_TIPO_EMPENHO, P_EMPRESA],
  },
  {
    name: 'despesas_empenhado_por_empenho',
    description:
      'Lista valores empenhados de um empenho específico em um período. Se IDButton não for enviado, o servidor usa lnkDespesasPor_NotaEmpenho por padrão, que é o contrato real da tela oficial.',
    category: 'Despesas',
    path: DESPESAS_PATH,
    listagem: 'EmpenhosDespesas_Empenhado_PorNumeroEmpenho',
    params: [...PARAMS_EMPENHO_PERIODO],
  },
  {
    name: 'despesas_liquidado_por_empenho',
    description:
      'Lista valores liquidados de um empenho específico em um período. Se IDButton não for enviado, o servidor usa lnkDespesasPor_NotaEmpenho por padrão, que é o contrato real da tela oficial.',
    category: 'Despesas',
    path: DESPESAS_PATH,
    listagem: 'EmpenhosDespesas_Liquidado_PorNumeroEmpenho',
    params: [...PARAMS_EMPENHO_PERIODO],
  },
  {
    name: 'despesas_pago_por_empenho',
    description:
      'Lista valores pagos de um empenho específico em um período. Se IDButton não for enviado, o servidor usa lnkDespesasPor_NotaEmpenho por padrão, que é o contrato real da tela oficial.',
    category: 'Despesas',
    path: DESPESAS_PATH,
    listagem: 'EmpenhosDespesas_Pago_PorNumeroEmpenho',
    params: [...PARAMS_EMPENHO_PERIODO],
  },
  {
    name: 'despesas_pago_ordem_pagamento',
    description:
      'Lista pagamentos com número da ordem de pagamento de um empenho.',
    category: 'Despesas',
    path: DESPESAS_PATH,
    listagem: 'Empenhos_Pago_ComOrdemPagto_PorNumeroEmpenho',
    params: [P_NUM_EMPENHO, P_TIPO_EMPENHO, P_EMPRESA],
  },
  {
    name: 'despesas_ordem_pagto_detalhes',
    description:
      'Detalhes de uma ordem de pagamento vinculada a um empenho.',
    category: 'Despesas',
    path: DESPESAS_PATH,
    listagem: 'OrdemPagto_Detalhes_PorNumeroEmpenho',
    params: [
      P_NUM_EMPENHO,
      P_TIPO_EMPENHO,
      P_EMPRESA,
      {
        name: 'strNumeroPagto',
        description: 'Número da ordem de pagamento',
        type: 'string',
        required: true,
      },
    ],
  },
  {
    name: 'despesas_ordem_pagto_parcelas',
    description:
      'Lista parcelas de uma ordem de pagamento vinculada a um empenho.',
    category: 'Despesas',
    path: DESPESAS_PATH,
    listagem: 'OrdemPagto_Parcelas_PorNumeroEmpenho',
    params: [
      P_NUM_EMPENHO,
      P_TIPO_EMPENHO,
      P_EMPRESA,
      {
        name: 'strNumeroPagto',
        description: 'Número da ordem de pagamento',
        type: 'string',
        required: true,
      },
    ],
  },
  {
    name: 'despesas_ordem_pagto_cheques',
    description:
      'Lista cheques emitidos para uma ordem de pagamento de um empenho.',
    category: 'Despesas',
    path: DESPESAS_PATH,
    listagem: 'OrdemPagto_Cheques_PorNumeroEmpenho',
    params: [
      P_NUM_EMPENHO,
      P_TIPO_EMPENHO,
      P_EMPRESA,
      {
        name: 'strNumeroPagto',
        description: 'Número da ordem de pagamento',
        type: 'string',
        required: true,
      },
    ],
  },
  {
    name: 'despesas_notas_fiscais_liquidacao',
    description:
      'Lista notas fiscais vinculadas à liquidação de um empenho.',
    category: 'Despesas',
    path: DESPESAS_PATH,
    listagem: 'NotasEmpenhoLiquidacao_PorNumeroEmpenho',
    params: [
      P_NUM_EMPENHO,
      P_TIPO_EMPENHO,
      P_EMPRESA,
      {
        name: 'strNumeroLiquidacao',
        description: 'Número da liquidação',
        type: 'string',
        required: true,
      },
    ],
  },
  {
    name: 'despesas_diarias',
    description:
      'Lista diárias pagas a servidores municipais em um período.',
    category: 'Despesas',
    path: DESPESAS_PATH,
    listagem: 'Diarias',
    params: [P_DIA_INICIO, P_MES_INICIO, P_DIA_FINAL, P_MES_FINAL, P_EXERCICIO, P_EMPRESA, P_CONSOLIDADO],
  },
  {
    name: 'despesas_restos_a_pagar',
    description:
      'Lista despesas inscritas em Restos a Pagar (compromissos de exercícios anteriores).',
    category: 'Despesas',
    path: DESPESAS_PATH,
    listagem: 'DespesasRestosPagar',
    params: [
      P_DIA_INICIO,
      P_MES_INICIO,
      P_DIA_FINAL,
      P_MES_FINAL,
      P_EXERCICIO,
      P_EMPRESA,
      P_APRESENTA_FAVORECIDO,
      P_CONSOLIDADO,
    ],
  },
  {
    name: 'despesas_extra_orcamentarias',
    description:
      'Lista despesas extra-orçamentárias (fora do orçamento regular) em um período.',
    category: 'Despesas',
    path: DESPESAS_PATH,
    listagem: 'DespesasExtraOrcamentaria',
    params: [
      P_DIA_INICIO,
      P_MES_INICIO,
      P_DIA_FINAL,
      P_MES_FINAL,
      P_EXERCICIO,
      P_EMPRESA,
      P_APRESENTA_FAVORECIDO,
      P_CONSOLIDADO,
    ],
  },
  {
    name: 'despesas_por_exigibilidade',
    description:
      'Lista despesas por ordem de exigibilidade (ordem cronológica de pagamento). Usa DiaInicioPeriodo e DiaFinalPeriodo como datas completas no formato DD.MM.AAAA; se strTipoLista não for informado, o servidor usa 1.',
    category: 'Despesas',
    path: DESPESAS_PATH,
    listagem: 'DespesasporExigibilidade',
    params: [
      {
        name: 'DiaInicioPeriodo',
        description: 'Data de início no formato DD.MM.AAAA (ex: 01.01.2024)',
        type: 'string',
        required: true,
      },
      {
        name: 'DiaFinalPeriodo',
        description: 'Data final no formato DD.MM.AAAA (ex: 31.12.2024)',
        type: 'string',
        required: true,
      },
      {
        name: 'strTipoLista',
        description: 'Tipo de listagem (1 = padrão)',
        type: 'string',
        required: true,
      },
      P_EMPRESA,
    ],
  },
];

// ─── RECEITAS ────────────────────────────────────────────────────────────────

const RECEITAS_PATH = '/VersaoJson/Receitas/';

const receitasTools: ToolDef[] = [
  {
    name: 'receitas_definir_exercicio',
    description:
      'Define o exercício fiscal (ano) para consultas de receitas.',
    category: 'Receitas',
    path: RECEITAS_PATH,
    listagem: 'DefineExercicio',
    params: [
      {
        name: 'ConectarExercicio',
        description: 'Ano do exercício a definir (ex: 2024)',
        type: 'string',
        required: true,
      },
    ],
  },
  {
    name: 'receitas_orcamentaria',
    description:
      'Lista receitas orçamentárias do município em um período. Pode filtrar por código de receita específico.',
    category: 'Receitas',
    path: RECEITAS_PATH,
    listagem: 'ReceitaOrcamentaria',
    params: [
      ...PARAMS_PERIODO,
      {
        name: 'CodigoReceita',
        description: 'Código específico da receita para filtrar (opcional)',
        type: 'string',
        required: false,
      },
    ],
  },
  {
    name: 'receitas_uniao',
    description:
      'Lista receitas provenientes de transferências da União (governo federal) em um período.',
    category: 'Receitas',
    path: RECEITAS_PATH,
    listagem: 'ReceitaUniao',
    params: [...PARAMS_PERIODO],
  },
  {
    name: 'receitas_estado',
    description:
      'Lista receitas provenientes de transferências do Estado em um período.',
    category: 'Receitas',
    path: RECEITAS_PATH,
    listagem: 'ReceitaEstado',
    params: [...PARAMS_PERIODO],
  },
  {
    name: 'receitas_extra_orcamentaria',
    description:
      'Lista receitas extra-orçamentárias em um período.',
    category: 'Receitas',
    path: RECEITAS_PATH,
    listagem: 'ReceitaExtraOrcamentaria',
    params: [...PARAMS_PERIODO],
  },
  {
    name: 'receitas_detalhes',
    description:
      'Retorna detalhes de uma receita orçamentária específica pelo seu código.',
    category: 'Receitas',
    path: RECEITAS_PATH,
    listagem: 'DetalhesReceitaOrcamentaria',
    params: [
      P_DIA_INICIO,
      P_MES_INICIO,
      P_DIA_FINAL,
      P_MES_FINAL,
      P_EXERCICIO,
      P_EMPRESA,
      {
        name: 'Codigochave',
        description: 'Código da receita para detalhar (ex: 1112.50.0.1)',
        type: 'string',
        required: true,
      },
      P_CONSOLIDADO,
    ],
  },
];

// ─── LICITAÇÕES E CONTRATOS ─────────────────────────────────────────────────

const LICITACOES_PATH = '/VersaoJson/LicitacoesEContratos/';

const licitacoesTools: ToolDef[] = [
  {
    name: 'licitacoes_definir_exercicio',
    description:
      'Define o exercício fiscal (ano) para consultas de licitações e contratos.',
    category: 'Licitações e Contratos',
    path: LICITACOES_PATH,
    listagem: 'DefineExercicio',
    params: [
      {
        name: 'ConectarExercicio',
        description: 'Ano do exercício a definir (ex: 2024)',
        type: 'string',
        required: true,
      },
    ],
  },
  {
    name: 'licitacoes_listar',
    description:
      'Lista todas as licitações do município em um exercício. Retorna modalidade, objeto, datas e valores.',
    category: 'Licitações e Contratos',
    path: LICITACOES_PATH,
    listagem: 'Licitacoes',
    params: [P_EXERCICIO, P_EMPRESA, P_CONSOLIDADO],
  },
  {
    name: 'contratos_listar',
    description:
      'Lista todos os contratos do município em um exercício. Retorna partes, objeto, valores e vigência.',
    category: 'Licitações e Contratos',
    path: LICITACOES_PATH,
    listagem: 'Contratos',
    params: [
      P_EXERCICIO,
      P_EMPRESA,
      P_CONSOLIDADO,
      {
        name: 'ContratosApenasPublicados',
        description: 'Mostrar apenas contratos publicados (True/False)',
        type: 'string',
        required: false,
      },
    ],
  },
];

// ─── TRANSFERÊNCIAS ──────────────────────────────────────────────────────────

const TRANSFERENCIAS_PATH = '/VersaoJson/Transferencias/';

const transferenciasTools: ToolDef[] = [
  {
    name: 'transferencias_definir_exercicio',
    description:
      'Define o exercício fiscal (ano) para consultas de transferências.',
    category: 'Transferências',
    path: TRANSFERENCIAS_PATH,
    listagem: 'DefineExercicio',
    params: [
      {
        name: 'ConectarExercicio',
        description: 'Ano do exercício a definir (ex: 2024)',
        type: 'string',
        required: true,
      },
    ],
  },
  {
    name: 'transferencias_entre_entidades',
    description:
      'Lista transferências financeiras entre entidades municipais (prefeitura, câmara, autarquias, etc).',
    category: 'Transferências',
    path: TRANSFERENCIAS_PATH,
    listagem: 'Transf',
    params: [P_EMPRESA, P_CONSOLIDADO],
  },
];

// ─── PESSOAL ─────────────────────────────────────────────────────────────────

const PESSOAL_PATH = '/VersaoJson/Pessoal/';

const pessoalTools: ToolDef[] = [
  {
    name: 'pessoal_definir_exercicio',
    description:
      'Define o exercício fiscal (ano) para consultas de pessoal.',
    category: 'Pessoal',
    path: PESSOAL_PATH,
    listagem: 'DefineExercicio',
    params: [
      {
        name: 'ConectarExercicio',
        description: 'Ano do exercício a definir (ex: 2024)',
        type: 'string',
        required: true,
      },
    ],
  },
  {
    name: 'pessoal_servidores',
    description:
      'Lista servidores públicos municipais com cargo, proventos, descontos e salário líquido.',
    category: 'Pessoal',
    path: PESSOAL_PATH,
    listagem: 'Servidores',
    params: [
      P_EMPRESA,
      P_EXERCICIO,
      P_MES_FINAL,
    ],
  },
];

// ─── DIÁRIO OFICIAL ──────────────────────────────────────────────────────────

export const diarioTools: ToolDef[] = [
  {
    name: 'listar_diarios',
    description: 'Lista todas as edições do Diário Oficial do município em ordem cronológica (mais recente primeiro). Suporta paginação. Use para navegar pelas edições sem busca por termo.',
    category: 'Diário Oficial',
    path: '',
    listagem: '',
    params: [
      {
        name: 'pagina',
        description: 'Número da página (1-indexed, padrão: 1)',
        type: 'number',
        required: false,
      },
      {
        name: 'por_pagina',
        description: 'Quantidade de itens por página (padrão: 10, max: 50)',
        type: 'number',
        required: false,
      }
    ],
  },
  {
    name: 'listar_diarios_por_data',
    description: 'Lista edições do Diário Oficial filtradas por intervalo de datas. Datas no formato DD/MM/AAAA. Útil para buscar diários de um período específico.',
    category: 'Diário Oficial',
    path: '',
    listagem: '',
    params: [
      {
        name: 'dataInicial',
        description: 'Data inicial no formato DD/MM/AAAA (ex: 01/01/2025)',
        type: 'string',
        required: true,
      },
      {
        name: 'dataFinal',
        description: 'Data final no formato DD/MM/AAAA (ex: 31/03/2025)',
        type: 'string',
        required: true,
      },
      {
        name: 'pagina',
        description: 'Número da página (1-indexed, padrão: 1)',
        type: 'number',
        required: false,
      },
      {
        name: 'por_pagina',
        description: 'Quantidade de itens por página (padrão: 10, max: 50)',
        type: 'number',
        required: false,
      }
    ],
  },
  {
    name: 'listar_diarios_por_secao',
    description: 'Lista edições do Diário Oficial filtradas por seção/categoria. Use listar_secoes_diario para ver seções disponíveis. Seções: 1=Atos Oficiais, 2=Atos Legislativos, 3=Atos Administrativos, 4=Licitações e Contratos, 5=Contas Públicas, 6=Concursos, 7=Outros Atos, 11=Advertências, 15=Conselhos.',
    category: 'Diário Oficial',
    path: '',
    listagem: '',
    params: [
      {
        name: 'id_secao',
        description: 'ID da seção (ex: 1=Atos Oficiais, 4=Licitações e Contratos)',
        type: 'string',
        required: true,
      },
      {
        name: 'pagina',
        description: 'Número da página (1-indexed, padrão: 1)',
        type: 'number',
        required: false,
      },
      {
        name: 'por_pagina',
        description: 'Quantidade de itens por página (padrão: 10, max: 50)',
        type: 'number',
        required: false,
      }
    ],
  },
  {
    name: 'listar_secoes_diario',
    description: 'Lista todas as seções/categorias disponíveis no Diário Oficial com seus IDs e quantidades de edições.',
    category: 'Diário Oficial',
    path: '',
    listagem: '',
    params: [],
  },
  {
    name: 'consultar_diario_oficial',
    description: 'Pesquisa o conteúdo das edições do Diário Oficial por termo, abrindo os PDFs e retornando os documentos/páginas onde a palavra aparece. Esta tool faz a descoberta e já devolve o trecho exato encontrado no PDF.',
    category: 'Diário Oficial',
    path: '',
    listagem: '',
    params: [
      {
        name: 'termo',
        description: 'Termo de busca (ex: licitação, convite, decreto)',
        type: 'string',
        required: true,
      },
      {
        name: 'dataInicial',
        description: 'Data inicial no formato DD/MM/AAAA (opcional)',
        type: 'string',
        required: false,
      },
      {
        name: 'dataFinal',
        description: 'Data final no formato DD/MM/AAAA (opcional)',
        type: 'string',
        required: false,
      },
    ],
  },
  {
    name: 'buscar_no_diario',
    description: 'Varre os PDFs do Diário Oficial e devolve documentos, páginas e trechos onde o termo aparece. Use esta tool para localizar citações dentro do diário e depois abrir apenas os PDFs encontrados.',
    category: 'Diário Oficial',
    path: '',
    listagem: '',
    params: [
      {
        name: 'termo',
        description: 'Termo de busca (ex: nome de pessoa, empresa ou palavra-chave)',
        type: 'string',
        required: true,
      },
      {
        name: 'dataInicial',
        description: 'Data inicial no formato DD/MM/AAAA (opcional)',
        type: 'string',
        required: false,
      },
      {
        name: 'dataFinal',
        description: 'Data final no formato DD/MM/AAAA (opcional)',
        type: 'string',
        required: false,
      },
    ],
  },
  {
    name: 'extrair_texto_diario',
    description: 'Extrai o conteúdo textual completo de uma edição do Diário Oficial a partir do PDF. Use a URL obtida de listar_diarios ou consultar_diario_oficial (campo url_pdf_direto ou url_original_eletronico).',
    category: 'Diário Oficial',
    path: '',
    listagem: '',
    params: [
      {
        name: 'url_pdf',
        description: 'A URL completa do visualizador do PDF (obtida via listar_diarios ou consultar_diario_oficial)',
        type: 'string',
        required: true,
      }
    ],
  },
  {
    name: 'extrair_texto_modo_leitura',
    description: 'Extrai o conteúdo textual de uma edição do Diário Oficial via Modo Texto (HTML). Geralmente mais rápido e mais limpo que a extração por PDF. Use a URL do campo url_modo_texto obtida de listar_diarios.',
    category: 'Diário Oficial',
    path: '',
    listagem: '',
    params: [
      {
        name: 'url_modo_texto',
        description: 'URL do modo texto ou o ID base64 da edição (obtida via listar_diarios, campo url_modo_texto)',
        type: 'string',
        required: true,
      }
    ],
  }
];

// ─── ANÁLISE INTELIGENTE ─────────────────────────────────────────────────────

const analiseTools: ToolDef[] = [
  {
    name: 'analise_despesas',
    description:
      'Análise completa de despesas por órgão com totais, ranking e alertas. Retorna resumo formatado em Markdown com TODOS os dados processados (zero perda). Muito mais eficiente que despesas_por_orgao pois já calcula totais e percentuais.',
    category: 'Análise',
    path: '',
    listagem: '',
    params: [
      {
        name: 'exercicio',
        description: 'Ano do exercício fiscal (ex: 2024)',
        type: 'string',
        required: true,
      },
      {
        name: 'mes_inicio',
        description: 'Mês inicial (01-12, padrão: 01)',
        type: 'string',
        required: false,
      },
      {
        name: 'mes_fim',
        description: 'Mês final (01-12, padrão: 12)',
        type: 'string',
        required: false,
      },
    ],
  },
  {
    name: 'analise_fornecedores',
    description:
      'Ranking completo de fornecedores com totais, percentuais de concentração e alertas de irregularidade. Processa 100% dos registros. Retorna Top N + resumo de demais. Muito mais eficiente que despesas_por_fornecedor.',
    category: 'Análise',
    path: '',
    listagem: '',
    params: [
      {
        name: 'exercicio',
        description: 'Ano do exercício fiscal (ex: 2024)',
        type: 'string',
        required: true,
      },
      {
        name: 'mes_inicio',
        description: 'Mês inicial (01-12, padrão: 01)',
        type: 'string',
        required: false,
      },
      {
        name: 'mes_fim',
        description: 'Mês final (01-12, padrão: 12)',
        type: 'string',
        required: false,
      },
      {
        name: 'top_n',
        description: 'Quantidade de fornecedores no ranking (padrão: 30)',
        type: 'number',
        required: false,
      },
    ],
  },
  {
    name: 'analise_servidores',
    description:
      'Análise completa da folha de pagamento: servidores ativos, demitidos/exonerados, top salários, distribuição por vínculo e alertas salariais. Processa 100% dos registros.',
    category: 'Análise',
    path: '',
    listagem: '',
    params: [
      {
        name: 'exercicio',
        description: 'Ano do exercício fiscal (ex: 2024)',
        type: 'string',
        required: true,
      },
      {
        name: 'mes',
        description: 'Mês de referência (01-12, padrão: último disponível)',
        type: 'string',
        required: false,
      },
      {
        name: 'top_n',
        description: 'Quantidade de servidores no ranking de salários (padrão: 20)',
        type: 'number',
        required: false,
      },
    ],
  },
  {
    name: 'analise_licitacoes',
    description:
      'Análise completa de licitações: por modalidade, dispensas, inexigibilidades, maiores valores e alertas. Processa 100% dos processos.',
    category: 'Análise',
    path: '',
    listagem: '',
    params: [
      {
        name: 'exercicio',
        description: 'Ano do exercício fiscal (ex: 2024)',
        type: 'string',
        required: true,
      },
    ],
  },
  {
    name: 'analise_contratos',
    description:
      'Análise completa de contratos: maiores valores, fornecedores recorrentes, vigências e alertas. Processa 100% dos contratos.',
    category: 'Análise',
    path: '',
    listagem: '',
    params: [
      {
        name: 'exercicio',
        description: 'Ano do exercício fiscal (ex: 2024)',
        type: 'string',
        required: true,
      },
    ],
  },
  {
    name: 'analise_receitas',
    description:
      'Análise completa de receitas: previsto vs arrecadado, execução orçamentária e alertas. Processa 100% das fontes de receita.',
    category: 'Análise',
    path: '',
    listagem: '',
    params: [
      {
        name: 'exercicio',
        description: 'Ano do exercício fiscal (ex: 2024)',
        type: 'string',
        required: true,
      },
      {
        name: 'mes_inicio',
        description: 'Mês inicial (01-12, padrão: 01)',
        type: 'string',
        required: false,
      },
      {
        name: 'mes_fim',
        description: 'Mês final (01-12, padrão: 12)',
        type: 'string',
        required: false,
      },
    ],
  },
  {
    name: 'analise_completa',
    description:
      'Relatório executivo completo de um exercício fiscal. Executa TODAS as análises (despesas, fornecedores, servidores, licitações, contratos, receitas) e gera um relatório consolidado com todos os alertas. Ideal para auditoria.',
    category: 'Análise',
    path: '',
    listagem: '',
    params: [
      {
        name: 'exercicio',
        description: 'Ano do exercício fiscal (ex: 2024)',
        type: 'string',
        required: true,
      },
      {
        name: 'mes_inicio',
        description: 'Mês inicial (01-12, padrão: 01)',
        type: 'string',
        required: false,
      },
      {
        name: 'mes_fim',
        description: 'Mês final (01-12, padrão: último disponível)',
        type: 'string',
        required: false,
      },
    ],
  },
];

// ─── EXPORTAÇÃO ──────────────────────────────────────────────────────────────

export const ALL_TOOLS: ToolDef[] = [
  ...despesasTools,
  ...receitasTools,
  ...licitacoesTools,
  ...transferenciasTools,
  ...pessoalTools,
  ...diarioTools,
];

// Mantido para compatibilidade interna/documental, mas nao exposto no MCP tools-only.
export const ANALYSIS_TOOLS: ToolDef[] = [...analiseTools];
