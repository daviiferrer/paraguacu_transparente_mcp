# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with this repository.

## Project Overview

MCP server (Model Context Protocol) for Brazilian municipal transparency portals using the **Fiorilli SCPI** system. Provides 32+ tools for querying public expenses, revenues, bids, contracts, personnel, and official gazette data. Default target is Paraguaçu Paulista (SP).

## Source Structure

- `src/index.ts` — MCP server entry point. Handles tool routing, session management (`DefineExercicio`), prompts, and resources. **Stdout is intercepted** at the top of the file to protect the MCP JSON-RPC protocol — only JSON-RPC messages pass through stdout; everything else goes to stderr.
- `src/api-client.ts` — HTTP client for the Fiorilli JSON API + DOSP (Diário Oficial) API. Manages ASP.NET session cookies, PDF text extraction via `unpdf`, JSONP parsing, and HTML text extraction.
- `src/tools.ts` — All tool definitions (`ToolDef[]` exported as `ALL_TOOLS`). Defines categories: Despesas, Receitas, Licitações e Contratos, Transferências, Pessoal, Diário Oficial, and Análise.
- `src/analytics.ts` — Server-side analysis engine. Takes raw API JSON, processes 100% of records (zero loss), outputs formatted Markdown with totals, rankings, and anomaly alerts.

## Key Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript → dist/
npm start            # Run compiled server (node dist/index.js)
npm run dev          # Run with tsx (no build needed)
npm run inspector    # Build + launch MCP Inspector for debugging
```

Node.js >= 18 required.

## Environment

Copied from `.env.example` into `.env`:

- `FIORILLI_BASE_URL` — Portal URL (default: Paraguaçu Paulista)
- `FIORILLI_EMPRESA` — Entity ID (1 = Prefeitura, 2 = Câmara)
- `FIORILLI_EXERCICIO` — Fiscal year (default: current year)

## Architecture Notes

**Stdout protection is critical.** The MCP protocol uses stdout exclusively for JSON-RPC. The file `src/index.ts` intercepts `process.stdout.write` at the very top (before any imports) to block non-JSON output. Any new code that writes to stdout must follow this pattern — use `process.stderr.write` for logging.

**Session management.** The Fiorilli API requires calling `DefineExercicio` before data queries, or monetary values come back as zero. The `ensureSession()` function in `index.ts` handles this automatically per category. Cookies are maintained in the `FiorilliApiClient` instance.

**Analysis tools vs raw data tools.** Tools prefixed `analise_` (e.g. `analise_despesas`, `analise_completa`) fetch and process data server-side via `analytics.ts`, returning compact Markdown. Raw tools (e.g. `despesas_por_orgao`) return full JSON. Prefer the analysis tools for summaries.

**Diário Oficial integration.** Uses the DOSP API (dosp.com.br) via JSONP endpoints and the imprensaoficialmunicipal.com.br portal for text search and HTML reading mode. Municipality ID 5050 = Paraguaçu Paulista.

## Testing

No test framework is configured. Manual testing is done via `npm run inspector` (MCP Inspector) or by connecting as an MCP client (e.g. Codex Desktop).
