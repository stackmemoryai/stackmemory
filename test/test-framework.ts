#!/usr/bin/env tsx
/**
 * StackMemory Testing Framework
 * Measures context quality and relevance over time
 */

import Database from 'better-sqlite3';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';

// Test scenarios that simulate real usage
const TEST_SCENARIOS = [
  {
    id: 'auth_decision',
    session: 1,
    query: 'How should we handle authentication?',
    decision: 'Use OAuth2 with JWT tokens for stateless auth',
    expectedContext: ['OAuth', 'JWT', 'authentication'],
    importance: 0.9
  },
  {
    id: 'database_choice',
    session: 1,
    query: 'What database should we use?',
    decision: 'PostgreSQL with pgvector for embeddings',
    expectedContext: ['PostgreSQL', 'pgvector', 'database'],
    importance: 0.9
  },
  {
    id: 'api_pattern',
    session: 1,
    query: 'API design pattern?',
    decision: 'RESTful API with GraphQL for complex queries',
    expectedContext: ['REST', 'GraphQL', 'API'],
    importance: 0.8
  },
  {
    id: 'auth_recall',
    session: 2,
    query: 'What auth method did we choose?',
    expectedContext: ['OAuth2', 'JWT', 'authentication'],
    shouldRecall: 'auth_decision',
    importance: null // Should retrieve previous
  },
  {
    id: 'new_feature',
    session: 2,
    query: 'How to implement user profiles?',
    decision: 'Separate profile service with Redis cache',
    expectedContext: ['profile', 'Redis', 'cache'],
    importance: 0.7
  },
  {
    id: 'bug_fix',
    session: 3,
    query: 'Login is broken, what was our auth setup?',
    expectedContext: ['OAuth2', 'JWT', 'authentication'],
    shouldRecall: 'auth_decision',
    importance: null
  },
  {
    id: 'performance',
    session: 3,
    query: 'Database queries are slow',
    decision: 'Add indexes and implement query caching',
    expectedContext: ['PostgreSQL', 'indexes', 'cache'],
    relatedTo: 'database_choice',
    importance: 0.6
  }
];

class StackMemoryTester {
  private db: Database.Database;
  private testResults: TestResult[] = [];
  private projectRoot: string;

  constructor() {
    this.projectRoot = process.cwd();
    const dbPath = join(this.projectRoot, '.stackmemory', 'test.db');
    
    // Ensure directory exists
    const dir = join(this.projectRoot, '.stackmemory');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.initDB();
  }

  private initDB() {
    // Same schema as production
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contexts (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        importance REAL DEFAULT 0.5,
        created_at INTEGER DEFAULT (unixepoch()),
        last_accessed INTEGER DEFAULT (unixepoch()),
        access_count INTEGER DEFAULT 1,
        session_id INTEGER
      );

      CREATE TABLE IF NOT EXISTS attention_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        context_id TEXT,
        query TEXT,
        response TEXT,
        influence_score REAL,
        session_id INTEGER,
        timestamp INTEGER DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS test_metrics (
        test_id TEXT PRIMARY KEY,
        scenario_id TEXT,
        session_id INTEGER,
        recall_accuracy REAL,
        context_relevance REAL,
        importance_drift REAL,
        response_time INTEGER,
        timestamp INTEGER DEFAULT (unixepoch())
      );
    `);
  }

  async runTests() {
    console.log(chalk.blue.bold('\n🧪 StackMemory Test Suite\n'));
    console.log(chalk.gray('Testing context quality over multiple sessions...\n'));

    // Group scenarios by session
    const sessions = this.groupBySession(TEST_SCENARIOS);

    for (const [sessionId, scenarios] of sessions) {
      console.log(chalk.yellow(`\n📅 Session ${sessionId}:`));
      await this.simulateSession(sessionId, scenarios);
      
      // Simulate time passing between sessions
      await this.simulateTimeDecay();
    }

    // Generate report
    this.generateReport();
  }

  private groupBySession(scenarios: typeof TEST_SCENARIOS) {
    const grouped = new Map<number, typeof TEST_SCENARIOS>();
    scenarios.forEach(s => {
      if (!grouped.has(s.session)) {
        grouped.set(s.session, []);
      }
      grouped.get(s.session)!.push(s);
    });
    return grouped;
  }

  private async simulateSession(sessionId: number, scenarios: typeof TEST_SCENARIOS) {
    for (const scenario of scenarios) {
      const startTime = Date.now();
      
      console.log(chalk.cyan(`  Testing: ${scenario.query}`));

      // Step 1: Query for context
      const retrievedContext = this.queryContext(scenario.query, sessionId);
      
      // Step 2: Add decision if present
      if (scenario.decision) {
        this.addDecision(scenario.id, scenario.decision, scenario.importance || 0.5, sessionId);
        console.log(chalk.green(`    ✓ Added decision: ${scenario.decision.substring(0, 50)}...`));
      }

      // Step 3: Measure recall accuracy
      let recallAccuracy = 0;
      if (scenario.shouldRecall) {
        recallAccuracy = this.measureRecall(retrievedContext, scenario.shouldRecall);
        console.log(chalk.blue(`    📊 Recall accuracy: ${(recallAccuracy * 100).toFixed(1)}%`));
      }

      // Step 4: Measure context relevance
      const relevance = this.measureRelevance(retrievedContext, scenario.expectedContext);
      console.log(chalk.blue(`    📊 Context relevance: ${(relevance * 100).toFixed(1)}%`));

      // Step 5: Track importance drift
      const importanceDrift = this.measureImportanceDrift(scenario.id);

      // Step 6: Log attention
      this.logAttention(scenario.id, scenario.query, retrievedContext, sessionId);

      // Record metrics
      const responseTime = Date.now() - startTime;
      this.recordMetrics({
        test_id: `${sessionId}_${scenario.id}`,
        scenario_id: scenario.id,
        session_id: sessionId,
        recall_accuracy: recallAccuracy,
        context_relevance: relevance,
        importance_drift: importanceDrift,
        response_time: responseTime
      });

      this.testResults.push({
        scenario: scenario.id,
        session: sessionId,
        recallAccuracy,
        relevance,
        importanceDrift,
        responseTime
      });
    }
  }

  private queryContext(query: string, sessionId: number): any[] {
    // Simulate context retrieval with importance weighting
    const contexts = this.db.prepare(`
      SELECT * FROM contexts
      WHERE content LIKE ? OR content LIKE ?
      ORDER BY importance DESC, access_count DESC
      LIMIT 5
    `).all(`%${query.split(' ')[0]}%`, `%${query.split(' ').pop()}%`) as any[];

    // Update access counts
    contexts.forEach(ctx => {
      this.db.prepare(`
        UPDATE contexts
        SET access_count = access_count + 1,
            last_accessed = unixepoch()
        WHERE id = ?
      `).run(ctx.id);
    });

    return contexts;
  }

  private addDecision(id: string, content: string, importance: number, sessionId: number) {
    this.db.prepare(`
      INSERT OR REPLACE INTO contexts (id, type, content, importance, session_id)
      VALUES (?, 'decision', ?, ?, ?)
    `).run(id, content, importance, sessionId);
  }

  private measureRecall(retrieved: any[], expectedId: string): number {
    const found = retrieved.find(ctx => ctx.id === expectedId);
    if (!found) return 0;
    
    // Higher score if it's ranked higher
    const position = retrieved.indexOf(found);
    return 1 - (position * 0.2); // 100% for first, 80% for second, etc.
  }

  private measureRelevance(retrieved: any[], expectedKeywords: string[]): number {
    if (retrieved.length === 0) return 0;

    let matches = 0;
    let total = expectedKeywords.length * retrieved.length;

    retrieved.forEach(ctx => {
      expectedKeywords.forEach(keyword => {
        if (ctx.content.toLowerCase().includes(keyword.toLowerCase())) {
          matches++;
        }
      });
    });

    return matches / total;
  }

  private measureImportanceDrift(contextId: string): number {
    const history = this.db.prepare(`
      SELECT importance FROM contexts WHERE id = ?
    `).get(contextId) as any;

    if (!history) return 0;

    // In a real system, we'd track importance changes over time
    // For now, simulate drift based on access count
    const accessCount = this.db.prepare(`
      SELECT access_count FROM contexts WHERE id = ?
    `).get(contextId) as any;

    if (accessCount) {
      // Higher access should increase importance
      const expectedImportance = Math.min(1, 0.5 + (accessCount.access_count * 0.1));
      return Math.abs(expectedImportance - history.importance);
    }

    return 0;
  }

  private logAttention(contextId: string, query: string, response: any[], sessionId: number) {
    // Simulate attention scoring
    const influenceScore = response.length > 0 ? 0.5 + (Math.random() * 0.5) : 0;
    
    this.db.prepare(`
      INSERT INTO attention_log (context_id, query, response, influence_score, session_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(contextId, query, JSON.stringify(response), influenceScore, sessionId);
  }

  private recordMetrics(metrics: any) {
    this.db.prepare(`
      INSERT INTO test_metrics (test_id, scenario_id, session_id, recall_accuracy, context_relevance, importance_drift, response_time)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      metrics.test_id,
      metrics.scenario_id,
      metrics.session_id,
      metrics.recall_accuracy,
      metrics.context_relevance,
      metrics.importance_drift,
      metrics.response_time
    );
  }

  private simulateTimeDecay() {
    // Simulate importance decay between sessions
    this.db.prepare(`
      UPDATE contexts
      SET importance = importance * 0.95
      WHERE last_accessed < unixepoch() - 3600
    `).run();
  }

  private generateReport() {
    console.log(chalk.blue.bold('\n\n📊 Test Results Summary\n'));

    // Overall metrics
    const avgRecall = this.average(this.testResults.map(r => r.recallAccuracy));
    const avgRelevance = this.average(this.testResults.map(r => r.relevance));
    const avgDrift = this.average(this.testResults.map(r => r.importanceDrift));
    const avgTime = this.average(this.testResults.map(r => r.responseTime));

    console.log(chalk.green('Overall Performance:'));
    console.log(`  Recall Accuracy:    ${this.getBar(avgRecall)} ${(avgRecall * 100).toFixed(1)}%`);
    console.log(`  Context Relevance:  ${this.getBar(avgRelevance)} ${(avgRelevance * 100).toFixed(1)}%`);
    console.log(`  Importance Stability: ${this.getBar(1 - avgDrift)} ${((1 - avgDrift) * 100).toFixed(1)}%`);
    console.log(`  Avg Response Time:  ${avgTime.toFixed(0)}ms`);

    // Per-session breakdown
    console.log(chalk.yellow('\nPer-Session Analysis:'));
    
    for (let session = 1; session <= 3; session++) {
      const sessionResults = this.testResults.filter(r => r.session === session);
      if (sessionResults.length === 0) continue;

      const sessionRecall = this.average(sessionResults.map(r => r.recallAccuracy));
      const sessionRelevance = this.average(sessionResults.map(r => r.relevance));
      
      console.log(`\n  Session ${session}:`);
      console.log(`    Recall:    ${this.getBar(sessionRecall)} ${(sessionRecall * 100).toFixed(1)}%`);
      console.log(`    Relevance: ${this.getBar(sessionRelevance)} ${(sessionRelevance * 100).toFixed(1)}%`);
    }

    // Learning curve
    console.log(chalk.cyan('\nLearning Curve:'));
    const learningData = this.analyzeLearningCurve();
    console.log(`  Session 1→2: ${learningData.improvement12 > 0 ? '📈' : '📉'} ${(learningData.improvement12 * 100).toFixed(1)}% improvement`);
    console.log(`  Session 2→3: ${learningData.improvement23 > 0 ? '📈' : '📉'} ${(learningData.improvement23 * 100).toFixed(1)}% improvement`);

    // Context usage patterns
    console.log(chalk.magenta('\nContext Usage Patterns:'));
    const patterns = this.analyzePatterns();
    patterns.forEach(p => {
      console.log(`  ${p.context}: accessed ${p.count}x (importance: ${p.importance.toFixed(2)})`);
    });

    // Generate detailed CSV report
    this.exportDetailedReport();

    console.log(chalk.gray('\n📁 Detailed report saved to .stackmemory/test-report.csv'));
    console.log(chalk.gray('📊 Database saved to .stackmemory/test.db for analysis\n'));
  }

  private average(numbers: number[]): number {
    if (numbers.length === 0) return 0;
    return numbers.reduce((a, b) => a + b, 0) / numbers.length;
  }

  private getBar(value: number): string {
    const filled = Math.round(value * 10);
    return '█'.repeat(filled) + '░'.repeat(10 - filled);
  }

  private analyzeLearningCurve() {
    const session1 = this.testResults.filter(r => r.session === 1);
    const session2 = this.testResults.filter(r => r.session === 2);
    const session3 = this.testResults.filter(r => r.session === 3);

    const avg1 = this.average(session1.map(r => r.relevance));
    const avg2 = this.average(session2.map(r => r.relevance));
    const avg3 = this.average(session3.map(r => r.relevance));

    return {
      improvement12: avg2 - avg1,
      improvement23: avg3 - avg2
    };
  }

  private analyzePatterns() {
    const patterns = this.db.prepare(`
      SELECT id as context, access_count as count, importance
      FROM contexts
      ORDER BY access_count DESC
      LIMIT 5
    `).all() as any[];

    return patterns;
  }

  private exportDetailedReport() {
    const detailed = this.db.prepare(`
      SELECT * FROM test_metrics
      ORDER BY session_id, timestamp
    `).all();

    const csv = [
      'test_id,scenario,session,recall_accuracy,relevance,importance_drift,response_time',
      ...detailed.map((r: any) => 
        `${r.test_id},${r.scenario_id},${r.session_id},${r.recall_accuracy},${r.context_relevance},${r.importance_drift},${r.response_time}`
      )
    ].join('\n');

    writeFileSync(join(this.projectRoot, '.stackmemory', 'test-report.csv'), csv);
  }

  cleanup() {
    this.db.close();
  }
}

// Test result interface
interface TestResult {
  scenario: string;
  session: number;
  recallAccuracy: number;
  relevance: number;
  importanceDrift: number;
  responseTime: number;
}

// Run tests if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const tester = new StackMemoryTester();
  tester.runTests()
    .then(() => {
      console.log(chalk.green.bold('✅ Testing complete!\n'));
      tester.cleanup();
    })
    .catch(error => {
      console.error(chalk.red('Test failed:'), error);
      tester.cleanup();
      process.exit(1);
    });
}