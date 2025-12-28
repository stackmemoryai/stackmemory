#!/usr/bin/env node
/**
 * Test Railway deployment
 */

import https from 'https';
import http from 'http';

const RAILWAY_URL = process.argv[2] || process.env.RAILWAY_URL;
const API_KEY = process.argv[3] || process.env.API_KEY_SECRET || 'a232e4cfe79628a729ba3e9ce29476422ebefb78f1db46fb7e8a6f11bebf5e0a';

if (!RAILWAY_URL) {
  console.error('Usage: node scripts/test-railway.js <RAILWAY_URL> [API_KEY]');
  console.error('Example: node scripts/test-railway.js https://your-app.railway.app');
  process.exit(1);
}

console.log(`🧪 Testing Railway deployment at: ${RAILWAY_URL}`);

async function makeRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    
    const req = client.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            data: res.headers['content-type']?.includes('application/json') ? JSON.parse(data) : data
          });
        } catch (e) {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            data: data
          });
        }
      });
    });
    
    req.on('error', reject);
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

async function runTests() {
  console.log('\n📊 Running health checks...\n');

  try {
    // 1. Health Check
    console.log('1. Testing health endpoint...');
    const health = await makeRequest(`${RAILWAY_URL}/health`);
    
    if (health.status === 200) {
      console.log('✅ Health check passed');
      console.log('   Status:', health.data.status);
      console.log('   Environment:', health.data.environment);
      console.log('   Uptime:', Math.round(health.data.uptime), 'seconds');
    } else {
      console.log('❌ Health check failed:', health.status);
      return;
    }

    // 2. Authentication Test
    console.log('\n2. Testing authentication...');
    const authTest = await makeRequest(`${RAILWAY_URL}/api/context/load`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    if (authTest.status === 200) {
      console.log('✅ Authentication working');
      console.log('   Contexts loaded:', authTest.data.contexts?.length || 0);
    } else {
      console.log('❌ Authentication failed:', authTest.status);
      console.log('   Error:', authTest.data?.error || 'Unknown error');
    }

    // 3. Save Context Test
    console.log('\n3. Testing context save...');
    const saveTest = await makeRequest(`${RAILWAY_URL}/api/context/save`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        content: 'Railway deployment test context',
        type: 'test',
        metadata: { deployedAt: new Date().toISOString() }
      })
    });

    if (saveTest.status === 200) {
      console.log('✅ Context save working');
      console.log('   Context ID:', saveTest.data.id);
    } else {
      console.log('❌ Context save failed:', saveTest.status);
      console.log('   Error:', saveTest.data?.error || 'Unknown error');
    }

    // 4. MCP Tool Test
    console.log('\n4. Testing MCP tool execution...');
    const toolTest = await makeRequest(`${RAILWAY_URL}/api/tools/execute`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        tool: 'load_context',
        params: {
          query: 'test',
          limit: 5
        }
      })
    });

    if (toolTest.status === 200) {
      console.log('✅ MCP tool execution working');
      console.log('   Found contexts:', toolTest.data.result?.contexts?.length || 0);
    } else {
      console.log('❌ MCP tool execution failed:', toolTest.status);
      console.log('   Error:', toolTest.data?.error || 'Unknown error');
    }

    // 5. Analytics Test (if enabled)
    console.log('\n5. Testing analytics endpoint...');
    const analyticsTest = await makeRequest(`${RAILWAY_URL}/api/analytics`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${API_KEY}`
      }
    });

    if (analyticsTest.status === 200) {
      console.log('✅ Analytics working');
      console.log('   Total contexts:', analyticsTest.data.analytics?.total_contexts || 0);
    } else {
      console.log('⚠️ Analytics not available (may be disabled)');
    }

    console.log('\n🎉 Railway deployment test complete!\n');
    console.log(`🔗 Your StackMemory MCP Server is running at: ${RAILWAY_URL}`);
    console.log(`🔑 API Key: ${API_KEY.substring(0, 8)}...`);
    
    console.log('\n📋 Claude.ai MCP Configuration:');
    console.log(`{
  "mcpServers": {
    "stackmemory": {
      "command": "curl",
      "args": [
        "-X", "POST",
        "-H", "Authorization: Bearer ${API_KEY}",
        "-H", "Content-Type: application/json",
        "-d", "{\\"tool\\": \\"load_context\\", \\"params\\": {\\"query\\": \\"\\", \\"limit\\": 10}}",
        "${RAILWAY_URL}/api/tools/execute"
      ]
    }
  }
}`);

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error('\n🔍 Troubleshooting:');
    console.error('1. Check if Railway deployment is complete');
    console.error('2. Verify environment variables are set');
    console.error('3. Check Railway logs for errors');
    console.error('4. Ensure PostgreSQL database is connected');
  }
}

runTests();