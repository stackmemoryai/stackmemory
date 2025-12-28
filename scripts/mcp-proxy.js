#!/usr/bin/env node
/**
 * MCP Proxy for Railway-hosted StackMemory
 * Bridges Claude Desktop to Railway API
 */

import https from 'https';

const RAILWAY_URL = process.env.RAILWAY_URL || 'https://stackmemory-production.up.railway.app';
const API_KEY = process.env.API_KEY;

if (!API_KEY) {
  console.error('ERROR: API_KEY environment variable is required');
  process.exit(1);
}

// Simple proxy that forwards MCP requests to Railway
process.stdin.on('data', async (data) => {
  try {
    const request = JSON.parse(data.toString());
    
    // Forward to Railway API
    const response = await makeRequest('/api/tools/execute', {
      tool: request.method,
      params: request.params
    });
    
    // Send response back to Claude
    process.stdout.write(JSON.stringify(response) + '\n');
  } catch (error) {
    process.stderr.write(`Error: ${error.message}\n`);
  }
});

async function makeRequest(path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, RAILWAY_URL);
    
    const options = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      }
    };
    
    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve({ error: data });
        }
      });
    });
    
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

console.error('StackMemory Railway MCP Proxy started');
console.error(`Connected to: ${RAILWAY_URL}`);