#!/usr/bin/env node
/**
 * Test Browser MCP integration locally
 */

import { BrowserMCPIntegration } from '../features/browser/browser-mcp.js';

async function testBrowserMCP() {
  console.log('🧪 Testing Browser MCP Integration...\n');

  const browser = new BrowserMCPIntegration({
    headless: false, // Show browser for testing
    defaultViewport: { width: 1280, height: 720 },
  });

  await browser.initialize();

  console.log('✅ Browser MCP initialized successfully!');
  console.log('\nAvailable tools:');
  console.log('  - browser_navigate');
  console.log('  - browser_screenshot');
  console.log('  - browser_click');
  console.log('  - browser_type');
  console.log('  - browser_evaluate');
  console.log('  - browser_wait');
  console.log('  - browser_get_content');
  console.log('  - browser_close');

  console.log('\n🎯 Browser MCP is ready to use with StackMemory!');

  // Clean up
  await browser.cleanup();
  process.exit(0);
}

testBrowserMCP().catch((error) => {
  console.error('❌ Browser MCP test failed:', error);
  process.exit(1);
});
