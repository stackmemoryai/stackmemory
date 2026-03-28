---
name: mcp-protocol
version: 2025.12.1
domain: protocol
expires: 2026-06-01
activates_on: [mcp, model context protocol, tool, resource, prompt, server, transport, stdio, sse, streamable]
sources:
  - https://modelcontextprotocol.io/docs
  - https://github.com/modelcontextprotocol/typescript-sdk
context7: modelcontextprotocol/typescript-sdk
---

# Model Context Protocol (MCP)

## SDK (@modelcontextprotocol/sdk)
```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'my-server', version: '1.0.0' });
```

## Tools
```ts
server.tool('tool_name', 'description', {
  param: z.string().describe('param description'),  // Zod schema
}, async ({ param }) => {
  return { content: [{ type: 'text', text: result }] };
});
```
- Input schema: Zod objects auto-converted to JSON Schema
- Return: `{ content: [{ type: 'text' | 'image' | 'resource', ... }] }`
- Error: `{ isError: true, content: [{ type: 'text', text: errorMsg }] }`

## Resources
```ts
server.resource('resource://uri', 'description', async (uri) => {
  return { contents: [{ uri, mimeType: 'text/plain', text: data }] };
});
```
- Static URI or template: `resource://users/{id}`
- `list_changed` notification when resources update

## Transports
- **Stdio**: `StdioServerTransport` — for CLI-launched servers (Claude Code default)
- **Streamable HTTP**: `StreamableHTTPServerTransport` — for networked servers
- **SSE** (deprecated): use Streamable HTTP instead for new servers

## Prompts
```ts
server.prompt('prompt_name', 'description', { arg: z.string() }, ({ arg }) => {
  return { messages: [{ role: 'user', content: { type: 'text', text: `...${arg}...` } }] };
});
```

## Client Side
```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
const client = new Client({ name: 'my-client', version: '1.0.0' });
await client.connect(transport);
const result = await client.callTool({ name: 'tool_name', arguments: { param: 'value' } });
```

## Gotchas
- Tool names: snake_case convention (not camelCase)
- Stdio transport: server MUST NOT write to stdout except MCP messages (use stderr for logs)
- Zod schemas: `.describe()` on each field — LLMs use descriptions for tool calling
- Error handling: return error content, don't throw (throws crash the server)
- Transport cleanup: `await server.close()` on shutdown
