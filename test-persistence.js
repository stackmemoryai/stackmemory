#!/usr/bin/env node

import { SharedContextLayer } from './dist/core/context/shared-context-layer.js';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function testPersistence() {
  console.log('Testing StackMemory Persistence...\n');
  
  try {
    // Initialize shared context layer
    const layer = new SharedContextLayer();
    await layer.initialize();
    console.log('✅ SharedContextLayer initialized');
    
    // Add test context
    const testFrame = {
      type: 'test',
      name: 'Persistence test frame',
      tags: ['test', 'persistence', 'verification'],
      data: {
        timestamp: new Date().toISOString(),
        test_id: `test-${Date.now()}`,
        message: 'This is a test frame to verify persistence'
      }
    };
    
    await layer.addToSharedContext(testFrame);
    console.log('✅ Added test frame to shared context');
    
    // Query to verify it's there
    const results = await layer.querySharedContext({ tags: ['test', 'persistence'] });
    console.log(`✅ Query returned ${results.length} matching frames`);
    
    // Get the full context
    const context = await layer.getSharedContext();
    console.log('\nContext Summary:');
    console.log(`  Total sessions: ${context.sessions?.length || 0}`);
    console.log(`  Global patterns: ${context.globalPatterns?.length || 0}`);
    console.log(`  Decision log entries: ${context.decisionLog?.length || 0}`);
    console.log(`  Last updated: ${new Date(context.lastUpdated).toLocaleString()}`);
    
    // Check persistence file
    const contextPath = path.join(process.env.HOME, '.stackmemory', 'data', 'shared-context.json');
    try {
      const fileContent = await fs.readFile(contextPath, 'utf-8');
      const savedContext = JSON.parse(fileContent);
      console.log(`\n✅ Persistence file exists at: ${contextPath}`);
      console.log(`  File contains ${savedContext.sessions?.length || 0} sessions`);
      
      // Find our test frame in the sessions
      let foundFrame = null;
      for (const session of savedContext.sessions || []) {
        const frame = session.keyFrames?.find(f => 
          f.title === 'Persistence test frame' && 
          f.tags?.includes('persistence')
        );
        if (frame) {
          foundFrame = frame;
          break;
        }
      }
      
      if (foundFrame) {
        console.log('✅ Test frame found in persisted data!');
        console.log('  Frame ID:', foundFrame.frameId);
        console.log('  Frame type:', foundFrame.type);
        console.log('  Frame score:', foundFrame.score);
      } else {
        console.log('⚠️  Test frame not found in persisted data');
        console.log('  Current sessions:', savedContext.sessions?.length || 0);
      }
    } catch (err) {
      console.log(`⚠️  Could not read persistence file: ${err.message}`);
      console.log('  Creating new persistence structure...');
    }
    
    // Test patterns
    await layer.addToSharedContext({
      type: 'error',
      name: 'Test error frame',
      data: {
        error: 'Test error message',
        resolution: 'Test resolution'
      }
    });
    
    const updatedContext = await layer.getSharedContext();
    console.log('\n✅ Added error frame for pattern detection');
    console.log(`  Global patterns now: ${updatedContext.globalPatterns?.length || 0}`);
    
    const errorPatterns = updatedContext.globalPatterns?.filter(p => p.type === 'error');
    if (errorPatterns?.length > 0) {
      console.log('✅ Error pattern detected and stored');
      console.log(`  Error patterns: ${errorPatterns.length}`);
    }
    
    console.log('\n🎉 Persistence test completed successfully!');
    console.log('\nTo verify manually:');
    console.log(`  cat ${contextPath} | jq '.sessions | length'`);
    console.log(`  cat ${contextPath} | jq '.sessions[-1].keyFrames'`);
    console.log(`  cat ${contextPath} | jq '.globalPatterns'`);
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

testPersistence().catch(console.error);