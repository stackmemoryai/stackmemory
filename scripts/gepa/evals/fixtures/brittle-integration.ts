// Integration handler that crashes on external API failure
// Needs graceful degradation following the DiffMem/Greptile pattern

interface MCPResponse {
  content: Array<{ type: string; text: string }>;
  metadata?: Record<string, unknown>;
}

// This handler crashes the entire MCP server when the API is unreachable.
// Refactor to degrade gracefully.
async function handleExternalLookup(args: {
  query: string;
  limit?: number;
}): Promise<MCPResponse> {
  const response = await fetch('https://api.external-service.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: args.query, limit: args.limit || 10 }),
  });

  // BUG: No error handling — fetch failures (ECONNREFUSED, DNS, timeout)
  // will throw and crash the MCP server process.
  // BUG: 4xx errors (bad request, auth failed) should not be retried.
  // BUG: Logs at error level, flooding logs when service is down.

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  const data = await response.json();

  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    metadata: { tool: 'external_lookup', resultCount: data.results?.length },
  };
}

export { handleExternalLookup };
