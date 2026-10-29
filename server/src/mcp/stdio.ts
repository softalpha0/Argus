#!/usr/bin/env node
// Argus MCP server over stdio, for agent hosts that launch local servers.
//
//   ARGUS_KEY=argus_... node server/dist/mcp/stdio.js
//   ARGUS_URL=http://localhost:8080 ARGUS_KEY=argus_... node server/dist/mcp/stdio.js
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ArgusClient } from './client.js';
import { createArgusMcpServer } from './tools.js';

const key = process.env.ARGUS_KEY?.trim();
if (!key) {
  // stdout carries the protocol, so messages for people go to stderr.
  console.error('Set ARGUS_KEY to an Argus API key (create one at https://tradeargusio.xyz/#/developers).');
  process.exit(1);
}
const client = new ArgusClient(process.env.ARGUS_URL?.trim() || 'https://tradeargusio.xyz', key);
await createArgusMcpServer(client).connect(new StdioServerTransport());
