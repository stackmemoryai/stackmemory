#!/usr/bin/env node

/**
 * Test script for StackMemory MCP Server
 * Simulates Claude Desktop MCP client
 */

import { spawn } from 'child_process';
import { createInterface } from 'readline';

console.log('🧪 StackMemory MCP Test Client');
console.log('==============================\n');

// Start the MCP server
const server = spawn(
  'node',
  ['dist/src/cli/cli.js', 'mcp-server', '--project', process.cwd()],
  {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      LINEAR_API_KEY: process.env.LINEAR_API_KEY || '',
    },
  }
);

// Handle server output
const rl = createInterface({
  input: server.stdout,
  crlfDelay: Infinity,
});

rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    console.log('📥 Server response:', JSON.stringify(msg, null, 2));
    handleServerMessage(msg);
  } catch (e) {
    // Non-JSON output
    if (line.trim()) {
      console.log('📝 Server output:', line);
    }
  }
});

// Handle server errors
server.stderr.on('data', (data) => {
  const output = data.toString().trim();
  if (output && !output.includes('MCP Server started')) {
    console.error('❌ Server error:', output);
  }
});

// Handle server message
function handleServerMessage(msg) {
  if (msg.method === 'notifications/initialized') {
    console.log('\n✅ Server initialized successfully!\n');
    testTools();
  }
}

// Send JSON-RPC message to server
function sendMessage(message) {
  const json = JSON.stringify(message);
  console.log('📤 Sending:', json);
  server.stdin.write(json + '\n');
}

// Initialize connection
console.log('\n🚀 Initializing MCP connection...\n');
sendMessage({
  jsonrpc: '2.0',
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {
      roots: {
        listChanged: true,
      },
      sampling: {},
    },
    clientInfo: {
      name: 'test-client',
      version: '1.0.0',
    },
  },
  id: 1,
});

// Test available tools
async function testTools() {
  console.log('📋 Listing available tools...\n');

  // List tools
  sendMessage({
    jsonrpc: '2.0',
    method: 'tools/list',
    params: {},
    id: 2,
  });

  // Wait a bit then test save_context
  setTimeout(() => {
    console.log('\n🔧 Testing save_context tool...\n');
    sendMessage({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'save_context',
        arguments: {
          content: 'Test context from MCP test client',
          importance: 0.8,
          tags: ['test', 'mcp'],
        },
      },
      id: 3,
    });
  }, 1000);

  // Test load_context
  setTimeout(() => {
    console.log('\n🔧 Testing load_context tool...\n');
    sendMessage({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'load_context',
        arguments: {
          query: 'test',
          limit: 5,
        },
      },
      id: 4,
    });
  }, 2000);

  // Test repo_status
  setTimeout(() => {
    console.log('\n🔧 Testing repo_status tool...\n');
    sendMessage({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'repo_status',
        arguments: {},
      },
      id: 5,
    });
  }, 3000);

  // Exit after tests
  setTimeout(() => {
    console.log('\n✅ All tests completed!\n');
    process.exit(0);
  }, 5000);
}

// Handle process termination
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down...');
  server.kill();
  process.exit(0);
});
