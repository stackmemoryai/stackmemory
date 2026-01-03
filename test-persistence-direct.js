#!/usr/bin/env node

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function testDirectPersistence() {
  console.log('Testing StackMemory Direct Persistence...\n');
  
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const contextDir = path.join(homeDir, '.stackmemory', 'shared-context', 'projects');
  
  // Ensure directory exists
  await fs.mkdir(contextDir, { recursive: true });
  console.log(`✅ Context directory ensured: ${contextDir}`);
  
  // Create test context
  const testContext = {
    projectId: 'test-persistence',
    branch: 'main',
    lastUpdated: Date.now(),
    sessions: [
      {
        sessionId: 'test-session-1',
        runId: 'test-run-1',
        summary: 'Test session for persistence verification',
        keyFrames: [
          {
            frameId: 'frame-1',
            title: 'Test Frame 1',
            type: 'observation',
            score: 0.9,
            tags: ['test', 'persistence'],
            summary: 'This is a test frame',
            createdAt: Date.now()
          },
          {
            frameId: 'frame-2',
            title: 'Error Frame',
            type: 'error',
            score: 0.8,
            tags: ['error', 'test'],
            summary: 'Test error with resolution',
            createdAt: Date.now()
          }
        ],
        createdAt: Date.now() - 3600000, // 1 hour ago
        lastActiveAt: Date.now(),
        metadata: { test: true }
      }
    ],
    globalPatterns: [
      {
        pattern: 'Test error pattern',
        type: 'error',
        frequency: 2,
        lastSeen: Date.now(),
        resolution: 'Test resolution'
      }
    ],
    decisionLog: [
      {
        id: 'decision-1',
        timestamp: Date.now(),
        sessionId: 'test-session-1',
        decision: 'Use persistence layer',
        rationale: 'For context continuity',
        outcome: 'success'
      }
    ],
    referenceIndex: {
      byTag: {},
      byType: {},
      recentlyAccessed: ['frame-1', 'frame-2']
    }
  };
  
  // Save context
  const contextFile = path.join(contextDir, `${testContext.projectId}_${testContext.branch}.json`);
  await fs.writeFile(contextFile, JSON.stringify(testContext, null, 2));
  console.log(`✅ Test context saved to: ${contextFile}`);
  
  // Verify it was saved
  const savedData = await fs.readFile(contextFile, 'utf-8');
  const savedContext = JSON.parse(savedData);
  
  console.log('\n📊 Saved Context Summary:');
  console.log(`  Sessions: ${savedContext.sessions.length}`);
  console.log(`  Key frames: ${savedContext.sessions[0].keyFrames.length}`);
  console.log(`  Global patterns: ${savedContext.globalPatterns.length}`);
  console.log(`  Decisions: ${savedContext.decisionLog.length}`);
  
  // Test that hooks can read this data
  console.log('\n🔍 Testing Hook Integration...');
  
  // Simulate what on-clear hook would do
  const clearSurvivalFrame = {
    frameId: 'clear-survival-' + Date.now(),
    title: 'Context preserved from /clear',
    type: 'clear_survival',
    score: 1.0,
    tags: ['preserved', 'clear_survival'],
    summary: 'Important context preserved across clear',
    createdAt: Date.now()
  };
  
  // Add to existing session
  savedContext.sessions[0].keyFrames.push(clearSurvivalFrame);
  savedContext.lastUpdated = Date.now();
  
  // Save updated context
  await fs.writeFile(contextFile, JSON.stringify(savedContext, null, 2));
  console.log('✅ Added clear_survival frame (simulating on-clear hook)');
  
  // Verify the update
  const updatedData = await fs.readFile(contextFile, 'utf-8');
  const updatedContext = JSON.parse(updatedData);
  
  const hasClearSurvival = updatedContext.sessions[0].keyFrames.some(
    f => f.tags?.includes('clear_survival')
  );
  
  if (hasClearSurvival) {
    console.log('✅ Clear survival frame persisted successfully!');
  } else {
    console.log('❌ Clear survival frame not found');
  }
  
  console.log('\n🎉 Direct persistence test completed!');
  console.log('\nTo verify manually:');
  console.log(`  cat ${contextFile} | jq '.sessions[0].keyFrames | length'`);
  console.log(`  cat ${contextFile} | jq '.sessions[0].keyFrames[] | select(.tags | contains(["clear_survival"]))'`);
  console.log(`  cat ${contextFile} | jq '.globalPatterns'`);
  
  // List all context files
  console.log('\n📁 All context files:');
  const files = await fs.readdir(contextDir);
  for (const file of files) {
    if (file.endsWith('.json')) {
      const stats = await fs.stat(path.join(contextDir, file));
      console.log(`  ${file} (${stats.size} bytes, modified: ${new Date(stats.mtime).toLocaleString()})`);
    }
  }
}

testDirectPersistence().catch(console.error);