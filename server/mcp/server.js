import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerTools } from './tools.js';

export function createMcpServer(services) {
  const server = new McpServer(
    { name: 'project-mcp', version: '0.2.0' },
    { capabilities: { tools: { listChanged: false } } }
  );
  registerTools(server, services);
  return server;
}
