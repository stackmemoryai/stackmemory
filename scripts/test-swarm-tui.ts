#!/usr/bin/env npx tsx

/**
 * Test script for Swarm TUI monitoring
 * Launches the TUI with mock data for testing
 */

import 'dotenv/config';
import { SwarmTUI } from '../src/features/tui/swarm-monitor.js';
import { logger } from '../src/core/monitoring/logger.js';

async function testSwarmTUI() {
  try {
    console.log('🦾 Starting Swarm TUI Test...');

    const tui = new SwarmTUI();

    // Initialize without swarm coordinator for testing
    await tui.initialize();

    // Start the TUI
    tui.start();

    console.log('TUI should now be running. Press q to quit.');
  } catch (error: unknown) {
    logger.error('TUI test failed', error as Error);
    console.error('❌ TUI test failed:', (error as Error).message);
    process.exit(1);
  }
}

// Run the test
testSwarmTUI();
