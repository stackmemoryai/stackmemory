#!/usr/bin/env node
/**
 * Trace Demo - Shows how the debug tracing works
 * Run with: DEBUG_TRACE=true npx tsx src/core/trace/trace-demo.ts
 */

import { 
  trace, 
  Trace, 
  TraceClass,
  enableVerboseTracing,
  createTracedDatabase,
  traceStep,
} from './index.js';
import { logger } from '../monitoring/logger.js';

// Example class with tracing
// @TraceClass() - decorators not enabled in tsconfig
class ExampleService {
  private data: Map<string, any> = new Map();

  async fetchData(id: string): Promise<any> {
    // Simulate API call
    await this.delay(50);
    
    if (id === 'error') {
      throw new Error('Simulated API error');
    }
    
    return { id, value: Math.random() };
  }

  async processData(data: any): Promise<any> {
    return traceStep('Data validation', async () => {
      await this.delay(20);
      
      if (!data.id) {
        throw new Error('Invalid data: missing ID');
      }
      
      return traceStep('Data transformation', async () => {
        await this.delay(30);
        return {
          ...data,
          processed: true,
          timestamp: Date.now(),
        };
      });
    });
  }

  cacheData(key: string, value: any): void {
    trace.traceSync('function', 'cacheData', { key, value }, () => {
      this.data.set(key, value);
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Example with database operations
async function databaseExample() {
  return trace.step('Database operations example', async () => {
    const db = createTracedDatabase(':memory:');
    
    // Create table
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);
    
    // Insert data
    const insert = db.prepare('INSERT INTO users (name, email) VALUES (?, ?)');
    insert.run('Alice', 'alice@example.com');
    insert.run('Bob', 'bob@example.com');
    
    // Query data
    const select = db.prepare('SELECT * FROM users WHERE name = ?');
    const user = select.get('Alice');
    
    // Complex query (will trigger slow query warning if threshold is low)
    const complex = db.prepare(`
      SELECT 
        name,
        COUNT(*) as count,
        MAX(created_at) as latest
      FROM users
      GROUP BY name
      HAVING COUNT(*) > 0
    `);
    const results = complex.all();
    
    db.close();
    
    return { user, results };
  });
}

// Main demo function
async function runDemo() {
  console.log('\n' + '='.repeat(80));
  console.log('STACKMEMORY DEBUG TRACE DEMO');
  console.log('='.repeat(80) + '\n');
  
  // Enable verbose tracing for the demo
  if (process.env.DEBUG_TRACE !== 'true') {
    console.log('📝 Enabling verbose tracing for this demo...\n');
    enableVerboseTracing();
  }
  
  try {
    // Example 1: Service operations
    await trace.command('demo:service', { example: 'service' }, async () => {
      const service = new ExampleService();
      
      console.log('\n--- Example 1: Service Operations ---\n');
      
      // Successful operation
      const data = await service.fetchData('test-1');
      const processed = await service.processData(data);
      service.cacheData('test-1', processed);
      
      console.log('✅ Service operation completed\n');
    });
    
    // Example 2: Database operations
    await trace.command('demo:database', { example: 'database' }, async () => {
      console.log('\n--- Example 2: Database Operations ---\n');
      
      const results = await databaseExample();
      
      console.log('✅ Database operations completed');
      console.log('   Found user:', results.user);
      console.log('   Query results:', results.results);
    });
    
    // Example 3: Error handling
    await trace.command('demo:errors', { example: 'errors' }, async () => {
      console.log('\n--- Example 3: Error Handling ---\n');
      
      const service = new ExampleService();
      
      try {
        await service.fetchData('error');
      } catch (error) {
        console.log('✅ Error properly traced and handled\n');
      }
    });
    
    // Example 4: Performance tracking
    await trace.command('demo:performance', { example: 'performance' }, async () => {
      console.log('\n--- Example 4: Performance Tracking ---\n');
      
      // Simulate slow operation
      await trace.step('Slow operation', async () => {
        await new Promise(resolve => setTimeout(resolve, 150));
      });
      
      // Simulate fast operations
      for (let i = 0; i < 3; i++) {
        await trace.step(`Fast operation ${i + 1}`, async () => {
          await new Promise(resolve => setTimeout(resolve, 10));
        });
      }
      
      console.log('✅ Performance tracking completed\n');
    });
    
  } catch (error) {
    console.error('❌ Demo failed:', error);
  }
  
  // Show execution summary
  console.log('\n' + trace.getExecutionSummary());
  
  // Export traces for analysis
  const traces = trace.exportTraces();
  console.log(`\n📊 Total traces collected: ${traces.length}`);
  
  // Show example trace entry
  if (traces.length > 0) {
    console.log('\n📍 Example trace entry:');
    console.log(JSON.stringify(traces[0], null, 2));
  }
}

// Run the demo
if (import.meta.url === `file://${process.argv[1]}`) {
  runDemo().catch(console.error);
}

export { runDemo };