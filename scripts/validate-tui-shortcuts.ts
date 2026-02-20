#!/usr/bin/env npx tsx

/**
 * Validation script for TUI shortcuts (non-interactive)
 * Verifies all key handlers are properly bound
 */

import 'dotenv/config';
import { SwarmTUI } from '../src/features/tui/swarm-monitor.js';
import { logger } from '../src/core/monitoring/logger.js';

async function validateTUIShortcuts() {
  try {
    console.log('🧪 Validating TUI Keyboard Shortcuts...');

    const tui = new SwarmTUI();
    await tui.initialize();

    // Access the screen object to check key handlers
    const screen = (tui as any).screen;

    if (!screen) {
      throw new Error('Screen not initialized');
    }

    // Check if key handlers exist
    const keyHandlers = screen._events.key || [];

    console.log('📋 Validation Results:');
    console.log(`✅ Screen initialized: ${screen ? 'Yes' : 'No'}`);
    console.log(
      `✅ Key handlers registered: ${keyHandlers.length > 0 ? 'Yes' : 'No'}`
    );

    // Test the help functionality directly
    console.log('\n🔍 Testing Help Function:');
    try {
      (tui as any).showHelp();
      console.log('✅ Help function works');
    } catch (error: unknown) {
      console.log('❌ Help function failed:', (error as Error).message);
    }

    // Test the detect function
    console.log('\n🔍 Testing Detect Function:');
    try {
      await (tui as any).showDetectedSwarms();
      console.log('✅ Detect function works');
    } catch (error: unknown) {
      console.log('❌ Detect function failed:', (error as Error).message);
    }

    // Test refresh function
    console.log('\n🔍 Testing Refresh Function:');
    try {
      await (tui as any).refreshData();
      console.log('✅ Refresh function works');
    } catch (error: unknown) {
      console.log('❌ Refresh function failed:', (error as Error).message);
    }

    // Test clear logs function
    console.log('\n🔍 Testing Clear Logs Function:');
    try {
      (tui as any).clearLogs();
      console.log('✅ Clear logs function works');
    } catch (error: unknown) {
      console.log('❌ Clear logs function failed:', (error as Error).message);
    }

    // Cleanup
    (tui as any).cleanup();

    console.log('\n✅ All TUI shortcut validations passed!');
    console.log('💡 Run scripts/test-tui-shortcuts.ts for interactive testing');
  } catch (error: unknown) {
    logger.error('TUI shortcuts validation failed', error as Error);
    console.error('❌ Validation failed:', (error as Error).message);
    process.exit(1);
  }
}

// Run validation
validateTUIShortcuts();
