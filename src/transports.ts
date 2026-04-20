import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { ALL_TOOLS } from './tools.js';
import { ALLOWED_HOSTS, HTTP_HOST, HTTP_PORT, createInitialState } from './runtime.js';
import { buildServer } from './server.js';

export async function startStdio(): Promise<void> {
  const state = createInitialState();
  const server = buildServer(state);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`MCP iniciado em stdio | tools=${ALL_TOOLS.length + 2}\n`);
}

export async function startHttp(): Promise<void> {
  const app = createMcpExpressApp({
    host: HTTP_HOST,
    allowedHosts: ALLOWED_HOSTS.length > 0 ? ALLOWED_HOSTS : ['localhost', '127.0.0.1', '::1'],
  });

  const sessions = new Map<string, { server: Server; transport: StreamableHTTPServerTransport }>();
  const legacySseSessions = new Map<string, { server: Server; transport: SSEServerTransport }>();

  const closeStreamableSession = async (sessionId: string): Promise<void> => {
    const active = sessions.get(sessionId);
    if (!active) return;
    sessions.delete(sessionId);
    await active.transport.close().catch(() => undefined);
    await active.server.close().catch(() => undefined);
  };

  app.get('/health', (_req: any, res: any) => {
    res.status(200).json({ ok: true, mode: 'http', transport: 'streamable-http' });
  });

  app.options('/mcp', (_req: any, res: any) => {
    res.status(204).set({
      allow: 'GET, POST, DELETE, OPTIONS',
      'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
      'access-control-allow-headers': 'content-type, mcp-session-id, mcp-protocol-version, last-event-id',
      'access-control-expose-headers': 'mcp-session-id',
    }).end();
  });

  app.post('/mcp', async (req: any, res: any) => {
    try {
      const sessionId = Array.isArray(req.headers['mcp-session-id']) ? req.headers['mcp-session-id'][0] : req.headers['mcp-session-id'];
      const active = sessionId ? sessions.get(String(sessionId)) : undefined;

      if (!active) {
        let initializedSessionId: string | undefined;
        let server!: Server;
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (newSessionId) => {
            initializedSessionId = newSessionId;
            sessions.set(newSessionId, { server, transport });
          },
        });
        server = buildServer(createInitialState());
        transport.onclose = () => {
          const id = initializedSessionId ?? transport.sessionId;
          if (id) void closeStreamableSession(id);
        };
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      await active.transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: `Erro interno: ${String(err)}` },
          id: null,
        });
      }
    }
  });

  app.get('/mcp', async (req: any, res: any) => {
    const sessionId = Array.isArray(req.headers['mcp-session-id']) ? req.headers['mcp-session-id'][0] : req.headers['mcp-session-id'];
    const active = sessionId ? sessions.get(String(sessionId)) : undefined;
    if (!sessionId || !active) {
      res.status(400).type('text/plain').send('Invalid or missing session ID');
      return;
    }
    await active.transport.handleRequest(req, res);
  });

  app.delete('/mcp', async (req: any, res: any) => {
    const sessionId = Array.isArray(req.headers['mcp-session-id']) ? req.headers['mcp-session-id'][0] : req.headers['mcp-session-id'];
    const active = sessionId ? sessions.get(String(sessionId)) : undefined;
    if (!sessionId || !active) {
      res.status(400).type('text/plain').send('Invalid or missing session ID');
      return;
    }
    await active.transport.handleRequest(req, res);
    await closeStreamableSession(String(sessionId));
  });

  app.get('/sse', async (_req: any, res: any) => {
    const server = buildServer(createInitialState());
    const transport = new SSEServerTransport('/messages', res);

    transport.onclose = async () => {
      legacySseSessions.delete(transport.sessionId);
      await server.close().catch(() => undefined);
    };

    legacySseSessions.set(transport.sessionId, { server, transport });
    await server.connect(transport);
    await transport.start();
  });

  app.post('/messages', async (req: any, res: any) => {
    const sessionId = String(req.query?.sessionId || '');
    const active = legacySseSessions.get(sessionId);
    if (!active) {
      res.status(404).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Sessao SSE legada ausente ou expirada.' },
        id: null,
      });
      return;
    }

    try {
      await active.transport.handlePostMessage(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: `Erro interno legado: ${String(err)}` },
          id: null,
        });
      }
    }
  });

  app.listen(HTTP_PORT, () => {
    process.stderr.write(`MCP HTTP em http://${HTTP_HOST}:${HTTP_PORT}/mcp | sse=/sse | health=/health\n`);
  });
}
