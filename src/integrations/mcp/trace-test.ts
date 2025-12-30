/**
 * Test the trace detection integration with MCP server
 */

import LocalStackMemoryMCP from './server';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';

async function testTraceIntegration() {
  console.log('🧪 Testing Trace Detection in MCP Server\n');

  // Mock minimal server setup
  const mockServer = {
    setRequestHandler: () => {},
    connect: () => Promise.resolve(),
  } as any;

  // Access the private methods through prototype
  const MCPClass = LocalStackMemoryMCP as any;
  const mcp = new MCPClass();

  // Simulate tool calls directly on the trace detector
  console.log('📋 Simulating tool calls:');

  // Simulate a search-driven trace
  const baseTime = Date.now();
  mcp.traceDetector.addToolCall({
    id: '1',
    tool: 'get_context',
    timestamp: baseTime,
    arguments: { query: 'authentication' },
  });
  console.log('  ✓ Added get_context');

  mcp.traceDetector.addToolCall({
    id: '2',
    tool: 'add_decision',
    timestamp: baseTime + 1000,
    arguments: { content: 'Use JWT tokens', type: 'decision' },
  });
  console.log('  ✓ Added add_decision');

  mcp.traceDetector.addToolCall({
    id: '3',
    tool: 'start_frame',
    timestamp: baseTime + 2000,
    arguments: { name: 'implement-auth' },
  });
  console.log('  ✓ Added start_frame');

  // Flush traces
  mcp.traceDetector.flush();

  // Get statistics
  const stats = await mcp.handleGetTraceStatistics({});
  console.log('\n📊 Trace Statistics:');
  console.log(stats.content[0].text);

  // Get traces
  const traces = await mcp.handleGetTraces({ limit: 10 });
  console.log('\n📝 Detected Traces:');
  console.log(traces.content[0].text);

  console.log('\n✅ MCP Trace Integration Test Complete!');
}

// Run the test
testTraceIntegration().catch(console.error);
