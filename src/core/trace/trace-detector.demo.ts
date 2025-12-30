/**
 * Demo script to showcase Trace Detection functionality
 */

import { TraceDetector } from './trace-detector.js';
import { ToolCall } from './types.js';
import { v4 as uuidv4 } from 'uuid';

// Create a new trace detector
const detector = new TraceDetector();

console.log('🔍 Trace Detection Demo\n');
console.log('='.repeat(50));

// Simulate a search-driven modification trace
console.log('\n📋 Simulating Search-Driven Modification:');
const baseTime = Date.now();

const searchDrivenTools: ToolCall[] = [
  {
    id: uuidv4(),
    tool: 'search',
    timestamp: baseTime,
    arguments: { query: 'authentication bug' },
  },
  {
    id: uuidv4(),
    tool: 'grep',
    timestamp: baseTime + 1000,
    arguments: { pattern: 'auth.*error' },
  },
  {
    id: uuidv4(),
    tool: 'read',
    timestamp: baseTime + 2000,
    filesAffected: ['/src/auth/login.ts'],
  },
  {
    id: uuidv4(),
    tool: 'edit',
    timestamp: baseTime + 3000,
    filesAffected: ['/src/auth/login.ts'],
  },
];

searchDrivenTools.forEach((tool) => {
  detector.addToolCall(tool);
  console.log(`  Added: ${tool.tool}`);
});

// Simulate an error recovery trace (separate due to time gap)
console.log('\n🔧 Simulating Error Recovery:');
const errorTime = baseTime + 40000; // 40 seconds later

const errorRecoveryTools: ToolCall[] = [
  {
    id: uuidv4(),
    tool: 'bash',
    timestamp: errorTime,
    arguments: { command: 'npm test' },
    error: 'Test failed: TypeError',
  },
  {
    id: uuidv4(),
    tool: 'edit',
    timestamp: errorTime + 1000,
    filesAffected: ['/src/utils/validator.ts'],
  },
  {
    id: uuidv4(),
    tool: 'bash',
    timestamp: errorTime + 2000,
    arguments: { command: 'npm test' },
    result: 'All tests passing',
  },
];

errorRecoveryTools.forEach((tool) => {
  detector.addToolCall(tool);
  console.log(`  Added: ${tool.tool}${tool.error ? ' (with error)' : ''}`);
});

// Simulate a feature implementation trace
console.log('\n✨ Simulating Feature Implementation:');
const featureTime = baseTime + 80000; // 80 seconds later

const featureTools: ToolCall[] = [
  {
    id: uuidv4(),
    tool: 'write',
    timestamp: featureTime,
    filesAffected: ['/src/components/Dashboard.tsx'],
  },
  {
    id: uuidv4(),
    tool: 'edit',
    timestamp: featureTime + 1000,
    filesAffected: ['/src/components/Dashboard.tsx'],
  },
  {
    id: uuidv4(),
    tool: 'test',
    timestamp: featureTime + 2000,
    arguments: { file: 'Dashboard.test.tsx' },
  },
];

featureTools.forEach((tool) => {
  detector.addToolCall(tool);
  console.log(`  Added: ${tool.tool}`);
});

// Flush any pending traces
detector.flush();

// Get statistics
console.log('\n📊 Trace Statistics:');
console.log('='.repeat(50));
const stats = detector.getStatistics();
console.log(`Total Traces: ${stats.totalTraces}`);
console.log(`Average Score: ${stats.averageScore.toFixed(2)}`);
console.log(`Average Length: ${stats.averageLength.toFixed(1)} tools`);
console.log(`High Importance (>0.7): ${stats.highImportanceCount}`);

console.log('\nTrace Types:');
Object.entries(stats.tracesByType).forEach(([type, count]) => {
  console.log(`  ${type}: ${count}`);
});

// Display all traces
console.log('\n📝 Detected Traces:');
console.log('='.repeat(50));
const traces = detector.getTraces();
traces.forEach((trace, index) => {
  console.log(`\nTrace ${index + 1}:`);
  console.log(`  Type: ${trace.type}`);
  console.log(`  Score: ${trace.score.toFixed(2)}`);
  console.log(`  Tools: ${trace.tools.map((t) => t.tool).join(' → ')}`);
  console.log(`  Summary: ${trace.summary}`);
  console.log(
    `  Duration: ${((trace.metadata.endTime - trace.metadata.startTime) / 1000).toFixed(1)}s`
  );

  if (trace.metadata.filesModified.length > 0) {
    console.log(`  Files Modified: ${trace.metadata.filesModified.join(', ')}`);
  }

  if (trace.metadata.errorsEncountered.length > 0) {
    console.log(`  Errors: ${trace.metadata.errorsEncountered.join(', ')}`);
  }

  if (trace.metadata.causalChain) {
    console.log(`  ✓ Causal Chain Detected (error→fix→verify)`);
  }
});

// Test high-importance trace filtering
console.log('\n⭐ High Importance Traces (score > 0.3):');
const highImportance = detector.getHighImportanceTraces(0.3);
highImportance.forEach((trace) => {
  console.log(
    `  [${trace.type}] Score: ${trace.score.toFixed(2)} - ${trace.summary}`
  );
});

// Export traces as JSON
console.log('\n💾 Exporting traces to JSON...');
const exported = detector.exportTraces();
console.log(`Exported ${exported.length} characters of JSON data`);

console.log('\n✅ Demo complete!');
