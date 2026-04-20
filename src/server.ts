import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { SessionState } from './runtime.js';
import { callTool, listTools } from './tool-handler.js';

export function buildServer(state: SessionState): Server {
  const server = new Server(
    { name: 'portal-transparencia', version: '3.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    return listTools(request.params?.cursor);
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments || {}) as Record<string, unknown>;
    return callTool(state, name, args);
  });

  return server;
}
