# MCP Fiorilli Transparencia

Servidor MCP para portais de transparencia com Fiorilli SCPI.

## O que mudou (v3)

- Resposta padrao em JSON estruturado (`structuredContent`) em todas as tools.
- Paginacao/chunking para evitar truncamento e travamento de contexto.
- Indexacao local do Diario Oficial com SQLite FTS5.
- Busca do Diario baseada em indice persistente, com indexacao incremental por lotes.
- Arquitetura MCP em `tools-only` (sem `prompts/*` e `resources/*`).
- `analise_*` removidas da superficie MCP; analises devem ser compostas no cliente consumidor.
- Filtros locais em todas as tools de dados:
  - `_pagina`, `_por_pagina`, `_cursor`
  - `_busca`, `_campos`, `_ordenar_por`, `_ordem`
- Suporte a transporte MCP por HTTP (Streamable HTTP) para deploy publico no Render.
- Portal fixo em Paraguaçu Paulista por padrão.
- `configurar_portal` endurecido para publico:
  - so altera configuracao se `MCP_ALLOW_CONFIG_UPDATE=true`.

## Ferramentas

Conjunto atual: tools de despesas, receitas, licitacoes/contratos, transferencias, pessoal e diario oficial.

## Instalacao

```bash
npm install
npm run build
```

## Variaveis de ambiente

```env
# Transporte MCP: stdio (default) ou http
MCP_TRANSPORT=stdio

# Porta/host para modo HTTP
PORT=3000
HOST=0.0.0.0

# Seguranca para servidor publico
MCP_ALLOW_CONFIG_UPDATE=false
MCP_ALLOWED_HOSTS=paraguacu-transparente-mcp.onrender.com,localhost,127.0.0.1

# Tuning de payload
MCP_DEFAULT_PAGE_SIZE=100
MCP_MAX_PAGE_SIZE=500
MCP_TEXT_BLOCK_CHARS=12000
MCP_TOOLS_LIST_PAGE_SIZE=200

# Tuning do Diario Oficial
MCP_DATA_DIR=/var/data/paraguacu-mcp
MCP_DIARIO_SCAN_BATCH_SIZE=8
MCP_DIARIO_SCAN_MAX_BATCHES=4
MCP_DIARIO_SCAN_TIME_BUDGET_MS=70000
```

## Execucao local

```bash
# stdio (desktop clients)
npm start

# HTTP (Render / publico)
MCP_TRANSPORT=http npm start
```

Endpoints no modo HTTP:

- `POST /mcp`
- `GET /mcp`
- `DELETE /mcp`
- `GET /health`

## Deploy no Render

- Build command: `npm install && npm run build`
- Start command: `node dist/index.js`
- Env obrigatorias:
  - `MCP_TRANSPORT=http`
  - `PORT` (Render injeta automaticamente)
- `MCP_ALLOW_CONFIG_UPDATE=false` (recomendado)
  - `MCP_ALLOWED_HOSTS` com o dominio publico do Render
- Para manter o indice do Diario entre deploys/restarts, monte um disco persistente
  no path usado por `MCP_DATA_DIR`.

## Notas de output

- O campo `content` traz preview textual curto.
- O payload completo da resposta fica em `structuredContent`.
- Para resultados grandes, use `next_cursor` (ou `_pagina`) para navegar sem perder dados.

## Licenca

MIT
