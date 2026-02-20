#!/usr/bin/env npx tsx

/**
 * Test script for TUI keyboard shortcuts
 * Tests all interactive features and key bindings
 */

import 'dotenv/config';
import { SwarmTUI } from '../src/features/tui/swarm-monitor.js';
import { logger } from '../src/core/monitoring/logger.js';

console.log('🧪 TUI Shortcuts Test Guide');
console.log('============================');
console.log('');
console.log('This will launch the TUI. Test these keyboard shortcuts:');
console.log('');
console.log('📋 Test Checklist:');
console.log('  [ ] q - Quit TUI (should exit cleanly)');
console.log('  [ ] Esc - Alternative quit (should exit cleanly)');
console.log('  [ ] Ctrl+C - Force quit (should exit cleanly)');
console.log('  [ ] r - Refresh data (should show "Manual refresh triggered")');
console.log('  [ ] h - Show help (should display full help in logs)');
console.log(
  '  [ ] c - Clear logs (should clear log area and show confirmation)'
);
console.log(
  '  [ ] d - Detect swarms (should show registry status and process info)'
);
console.log('  [ ] s - Start swarm help (should show example commands)');
console.log('  [ ] t - Stop swarm (should show appropriate message)');
console.log('');
console.log('🎯 Expected Behavior:');
console.log('  - All shortcuts should work without errors');
console.log('  - Log messages should appear in the bottom panel');
console.log('  - Help text should be comprehensive');
console.log('  - Detection should show registry and external processes');
console.log('  - Interface should remain responsive');
console.log('');
console.log('Press Enter to launch TUI...');

// Wait for user input
await new Promise((resolve) => {
  process.stdin.once('data', resolve);
});

async function testTUIShortcuts() {
  try {
    console.log('🚀 Launching TUI for shortcut testing...');

    const tui = new SwarmTUI();

    // Initialize TUI
    await tui.initialize();

    // Start the TUI
    tui.start();

    console.log('✅ TUI launched successfully');
    console.log('📝 Test each keyboard shortcut systematically');
    console.log('🏁 Use "q" to quit when testing is complete');
  } catch (error: unknown) {
    logger.error('TUI shortcuts test failed', error as Error);
    console.error('❌ TUI shortcuts test failed:', (error as Error).message);
    process.exit(1);
  }
}

// Run the test
testTUIShortcuts();
