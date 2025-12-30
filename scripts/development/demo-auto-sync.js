#!/usr/bin/env node
/**
 * Demo: Linear Auto-Sync Functionality
 * Demonstrates how the auto-sync works locally
 */

import {
  initializeAutoSync,
  getAutoSyncService,
} from '../../dist/src/integrations/linear-auto-sync.js';

console.log('🚀 Linear Auto-Sync Demo\n');

// Simulate a project directory
const projectRoot = process.cwd();

console.log('📋 Demo Scenario:');
console.log('- Configure auto-sync with 30-second intervals');
console.log('- Show service status and configuration');
console.log(
  '- Simulate what happens during sync (without actual Linear connection)'
);
console.log('- Demonstrate configuration management\n');

// Step 1: Initialize auto-sync service
console.log('1️⃣ Initializing auto-sync service...');
const autoSyncService = initializeAutoSync(projectRoot, {
  interval: 0.5, // 30 seconds for demo
  direction: 'bidirectional',
  conflictResolution: 'newest_wins',
  enabled: true,
  retryAttempts: 2,
  retryDelay: 5000, // 5 seconds
});

console.log('✅ Auto-sync service initialized\n');

// Step 2: Show service status
console.log('2️⃣ Current service status:');
const status = autoSyncService.getStatus();
console.log(`   Running: ${status.running ? '✅' : '❌'}`);
console.log(`   Interval: ${status.config.interval} minutes`);
console.log(`   Direction: ${status.config.direction}`);
console.log(`   Conflict Resolution: ${status.config.conflictResolution}`);
console.log(`   Retry Attempts: ${status.config.retryAttempts}`);

if (status.config.quietHours) {
  console.log(
    `   Quiet Hours: ${status.config.quietHours.start}:00 - ${status.config.quietHours.end}:00`
  );
}

console.log('\n');

// Step 3: Simulate configuration updates
console.log('3️⃣ Demonstrating configuration updates...');
autoSyncService.updateConfig({
  interval: 1, // Change to 1 minute
  conflictResolution: 'linear_wins',
});
console.log('✅ Updated: interval=1min, conflict_resolution=linear_wins\n');

// Step 4: Show updated status
console.log('4️⃣ Updated service status:');
const updatedStatus = autoSyncService.getStatus();
console.log(`   Interval: ${updatedStatus.config.interval} minutes`);
console.log(
  `   Conflict Resolution: ${updatedStatus.config.conflictResolution}\n`
);

// Step 5: Demonstrate the auto-sync would work with Linear
console.log('5️⃣ How auto-sync works with Linear:');
console.log('');
console.log('🔄 **Automatic Synchronization Process:**');
console.log('   1. Every N minutes (configurable), check for changes');
console.log('   2. Sync StackMemory tasks → Linear issues');
console.log('   3. Sync Linear issues → StackMemory task updates');
console.log(
  '   4. Handle conflicts based on strategy (newest_wins, linear_wins, etc.)'
);
console.log('   5. Log results and schedule next sync');
console.log('');
console.log('📊 **Status Mapping:**');
console.log('   StackMemory pending     → Linear Backlog');
console.log('   StackMemory in_progress → Linear In Progress');
console.log('   StackMemory completed   → Linear Done');
console.log('   StackMemory blocked     → Linear Blocked');
console.log('');
console.log('⚡ **Smart Features:**');
console.log('   • Quiet hours (no sync 10pm-7am by default)');
console.log('   • Automatic retry with exponential backoff');
console.log('   • Conflict detection and resolution');
console.log('   • Persistent configuration');
console.log('   • Background service support');
console.log('');

// Step 6: Show NPM integration
console.log('6️⃣ NPM Package Integration:');
console.log('');
console.log('📦 **Available Commands:**');
console.log('   npm run linear:setup     # Setup Linear OAuth');
console.log('   npm run linear:status    # Check integration status');
console.log('   npm run linear:config    # View/edit configuration');
console.log('   npm run linear:auto-sync # Start auto-sync service');
console.log('');
console.log('🔧 **Manual Commands:**');
console.log('   stackmemory linear config --set-interval 10');
console.log('   stackmemory linear auto-sync --start');
console.log('   stackmemory linear force-sync');
console.log('');

// Step 7: Cleanup
console.log('7️⃣ Stopping demo service...');
autoSyncService.stop();
console.log('✅ Demo completed!\n');

console.log('🎯 **To Use in Production:**');
console.log('1. Set up Linear OAuth: stackmemory linear setup');
console.log('2. Authorize integration: stackmemory linear authorize <code>');
console.log(
  '3. Configure auto-sync: stackmemory linear config --set-interval 5'
);
console.log('4. Start auto-sync: stackmemory linear auto-sync --start');
console.log('');
console.log('📖 **Documentation:**');
console.log('   All settings persist in .stackmemory/linear-auto-sync.json');
console.log('   Auto-sync runs as a background process within the npm package');
console.log('   No external services required - everything runs locally');
