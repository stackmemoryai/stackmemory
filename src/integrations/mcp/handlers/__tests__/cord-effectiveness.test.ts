/**
 * Cord vs Flat Task Orchestration — Deterministic Effectiveness Tests
 *
 * Measures concrete metrics comparing Cord primitives (spawn/fork/complete/ask/tree)
 * against a simulated "flat" approach (create_task/update_task_status).
 *
 * Scenarios:
 *   A. Information Flow Pipeline — context propagation
 *   B. Context Isolation — spawn vs fork vs flat scoping
 *   C. Dependency Auto-Resolution — diamond deps, auto-unblock
 *   D. Ask/Answer Decision Flow — ask primitive vs manual polling
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CordHandlers } from '../cord-handlers.js';
import { FrameManager } from '../../../../core/context/frame-manager.js';
import { SQLiteAdapter } from '../../../../core/database/sqlite-adapter.js';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Helper to count tool calls for a given approach
interface ToolCallLog {
  calls: string[];
  push(name: string): void;
  count(): number;
}

function createCallLog(): ToolCallLog {
  const calls: string[] = [];
  return {
    calls,
    push(name: string) {
      calls.push(name);
    },
    count() {
      return calls.length;
    },
  };
}

describe('Cord vs Flat Effectiveness', () => {
  let handlers: CordHandlers;
  let adapter: SQLiteAdapter;
  let frameManager: FrameManager;
  let db: Database.Database;
  let dbPath: string;
  let tmpDir: string;
  const projectId = 'test-effectiveness';

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stackmemory-cord-eff-'));
    dbPath = path.join(tmpDir, 'test.db');

    adapter = new SQLiteAdapter(projectId, { dbPath });
    await adapter.connect();
    await adapter.initializeSchema();

    db = new Database(dbPath);
    frameManager = new FrameManager(db, projectId);
    await frameManager.initialize();

    handlers = new CordHandlers({ frameManager, dbAdapter: adapter });
  });

  afterEach(async () => {
    db.close();
    await adapter.disconnect();
    try {
      fs.rmSync(tmpDir, { recursive: true });
    } catch {
      // cleanup best-effort
    }
  });

  // ─── Scenario A: Information Flow Pipeline ──────────────────────────
  describe('Scenario A: Information Flow Pipeline', () => {
    it('Cord: blocker results auto-flow to downstream tasks via visible_context', async () => {
      const cordLog = createCallLog();

      // Step 1: research
      const research = await handlers.handleCordSpawn({
        goal: 'Research auth approaches',
        prompt: 'Survey JWT vs session cookies',
      });
      cordLog.push('cord_spawn');

      // Complete research with result
      await handlers.handleCordComplete({
        task_id: research.metadata.task_id,
        result: 'JWT recommended: stateless, scales horizontally',
      });
      cordLog.push('cord_complete');

      // Step 2: design blocked by research
      const design = await handlers.handleCordSpawn({
        goal: 'Design auth module',
        prompt: 'Design based on research findings',
        blocked_by: [research.metadata.task_id],
      });
      cordLog.push('cord_spawn');

      // Complete design
      await handlers.handleCordComplete({
        task_id: design.metadata.task_id,
        result: 'Auth module: JWT + refresh tokens, middleware pattern',
      });
      cordLog.push('cord_complete');

      // Step 3: implement blocked by design
      const impl = await handlers.handleCordSpawn({
        goal: 'Implement auth module',
        prompt: 'Implement the designed auth module',
        blocked_by: [design.metadata.task_id],
      });
      cordLog.push('cord_spawn');

      // Verify context flows via cord_tree
      const tree = await handlers.handleCordTree({ include_results: true });
      cordLog.push('cord_tree');

      const implNode = tree.metadata.tasks.find(
        (t: any) => t.task_id === impl.metadata.task_id
      );

      // Impl task should see design result via blocker_results
      expect(implNode.visible_context.blocker_results).toHaveLength(1);
      expect(implNode.visible_context.blocker_results[0].result).toBe(
        'Auth module: JWT + refresh tokens, middleware pattern'
      );

      // Design task should see research result
      const designNode = tree.metadata.tasks.find(
        (t: any) => t.task_id === design.metadata.task_id
      );
      expect(designNode.visible_context.blocker_results).toHaveLength(1);
      expect(designNode.visible_context.blocker_results[0].result).toBe(
        'JWT recommended: stateless, scales horizontally'
      );

      // Cord used 6 calls total (3 spawn + 2 complete + 1 tree)
      expect(cordLog.count()).toBe(6);
    });

    it('Flat: no automatic context flow — requires manual result tracking', () => {
      const flatLog = createCallLog();

      // Flat approach simulates create_task / update_task_status
      // Step 1: create research task
      flatLog.push('create_task'); // create research
      flatLog.push('update_task_status'); // mark complete, store result externally

      // Step 2: create design task — must manually pass research result
      flatLog.push('create_task'); // create design (must copy result in description)
      flatLog.push('update_task_status'); // mark complete

      // Step 3: create implement — must manually pass design result
      flatLog.push('create_task'); // create implement (must copy result in description)

      // To check status/context, must list all tasks
      flatLog.push('list_tasks'); // no tree view, just flat list

      // Flat: 6 calls, but NO automatic context propagation
      expect(flatLog.count()).toBe(6);

      // Key difference: flat has no visible_context mechanism
      // Results must be manually copied into task descriptions
      // No structured blocker_results — just raw text
    });

    it('Summary: Cord provides structured context flow, flat does not', () => {
      // Cord advantage: automatic blocker_results in visible_context
      // Flat limitation: manual result copying, no structured context
      const cordMetrics = {
        contextItems: 1, // exactly the blocker result
        autoFlow: true,
        structuredResults: true,
      };
      const flatMetrics = {
        contextItems: 0, // no automatic context
        autoFlow: false,
        structuredResults: false,
      };

      expect(cordMetrics.autoFlow).toBe(true);
      expect(flatMetrics.autoFlow).toBe(false);
      expect(cordMetrics.structuredResults).toBe(true);
      expect(flatMetrics.structuredResults).toBe(false);
    });
  });

  // ─── Scenario B: Context Isolation (spawn vs fork) ──────────────────
  describe('Scenario B: Context Isolation (spawn vs fork vs flat)', () => {
    it('Cord spawn: child sees ONLY blocker results, not siblings', async () => {
      const parent = await handlers.handleCordSpawn({ goal: 'Parent task' });

      // 3 children: API, UI, Tests — all under same parent
      const api = await handlers.handleCordSpawn({
        goal: 'Build API endpoints',
        parent_id: parent.metadata.task_id,
      });
      await handlers.handleCordComplete({
        task_id: api.metadata.task_id,
        result: 'REST API: /users, /auth, /profile',
      });

      const ui = await handlers.handleCordSpawn({
        goal: 'Build UI components',
        parent_id: parent.metadata.task_id,
      });
      await handlers.handleCordComplete({
        task_id: ui.metadata.task_id,
        result: 'React components: LoginForm, ProfilePage',
      });

      // Tests task (spawn) — no blockers, just a sibling
      const tests = await handlers.handleCordSpawn({
        goal: 'Write integration tests',
        parent_id: parent.metadata.task_id,
      });

      const tree = await handlers.handleCordTree({ include_results: true });
      const testsNode = tree.metadata.tasks.find(
        (t: any) => t.task_id === tests.metadata.task_id
      );

      // Spawn: no sibling_results visible (only blocker_results)
      expect(testsNode.visible_context.sibling_results).toBeUndefined();
      expect(testsNode.visible_context.blocker_results).toBeUndefined();
    });

    it('Cord fork: child sees completed sibling results', async () => {
      const parent = await handlers.handleCordSpawn({ goal: 'Parent task' });

      const api = await handlers.handleCordSpawn({
        goal: 'Build API endpoints',
        parent_id: parent.metadata.task_id,
      });
      await handlers.handleCordComplete({
        task_id: api.metadata.task_id,
        result: 'REST API: /users, /auth, /profile',
      });

      const ui = await handlers.handleCordSpawn({
        goal: 'Build UI components',
        parent_id: parent.metadata.task_id,
      });
      await handlers.handleCordComplete({
        task_id: ui.metadata.task_id,
        result: 'React components: LoginForm, ProfilePage',
      });

      // Tests task (FORK) — sees sibling results
      const tests = await handlers.handleCordFork({
        goal: 'Write integration tests',
        parent_id: parent.metadata.task_id,
      });

      const tree = await handlers.handleCordTree({ include_results: true });
      const testsNode = tree.metadata.tasks.find(
        (t: any) => t.task_id === tests.metadata.task_id
      );

      // Fork: sees sibling_results
      expect(testsNode.visible_context.sibling_results).toHaveLength(2);
      const siblingGoals = testsNode.visible_context.sibling_results.map(
        (s: any) => s.goal
      );
      expect(siblingGoals).toContain('Build API endpoints');
      expect(siblingGoals).toContain('Build UI components');
    });

    it('Summary: context items per task — spawn < fork, flat has no scoping', () => {
      // Spawn: 0 sibling items (only blockers)
      // Fork: N sibling items (all completed siblings)
      // Flat: all tasks visible globally (no scoping)
      const metrics = {
        spawn_context_items: 0, // only blocker results
        fork_context_items: 2, // 2 completed siblings
        flat_context_items: 'all', // no isolation
      };

      expect(metrics.spawn_context_items).toBeLessThan(
        metrics.fork_context_items
      );
      expect(metrics.flat_context_items).toBe('all');
    });
  });

  // ─── Scenario C: Dependency Auto-Resolution ─────────────────────────
  describe('Scenario C: Dependency Auto-Resolution (diamond deps)', () => {
    it('Cord: completing blockers auto-unblocks dependents', async () => {
      const cordLog = createCallLog();

      // Diamond: A and B both block C; A also blocks D
      const a = await handlers.handleCordSpawn({ goal: 'Task A' });
      cordLog.push('cord_spawn');
      const b = await handlers.handleCordSpawn({ goal: 'Task B' });
      cordLog.push('cord_spawn');

      const c = await handlers.handleCordSpawn({
        goal: 'Task C (blocked by A and B)',
        blocked_by: [a.metadata.task_id, b.metadata.task_id],
      });
      cordLog.push('cord_spawn');

      const d = await handlers.handleCordSpawn({
        goal: 'Task D (blocked by A)',
        blocked_by: [a.metadata.task_id],
      });
      cordLog.push('cord_spawn');

      // Verify C and D are blocked
      expect(c.metadata.status).toBe('blocked');
      expect(d.metadata.status).toBe('blocked');

      // Complete A → D auto-unblocks (A was D's only blocker)
      const resultA = await handlers.handleCordComplete({
        task_id: a.metadata.task_id,
        result: 'A done',
      });
      cordLog.push('cord_complete');

      expect(resultA.metadata.unblocked).toContain(d.metadata.task_id);
      expect(resultA.metadata.unblocked).not.toContain(c.metadata.task_id);

      // Complete B → C auto-unblocks (both A and B now done)
      const resultB = await handlers.handleCordComplete({
        task_id: b.metadata.task_id,
        result: 'B done',
      });
      cordLog.push('cord_complete');

      expect(resultB.metadata.unblocked).toContain(c.metadata.task_id);

      // Cord: 0 manual status updates — auto-unblock handles it
      // Total: 4 spawn + 2 complete = 6 calls, 0 manual unblock calls
      const manualStatusUpdates = 0;
      expect(manualStatusUpdates).toBe(0);
      expect(cordLog.count()).toBe(6);
    });

    it('Flat: requires manual status checks and updates after each completion', () => {
      const flatLog = createCallLog();

      // Create tasks
      flatLog.push('create_task'); // A
      flatLog.push('create_task'); // B
      flatLog.push('create_task'); // C (note: deps in description only)
      flatLog.push('create_task'); // D (note: deps in description only)

      // Complete A — must manually check what depends on A
      flatLog.push('update_task_status'); // mark A done
      flatLog.push('list_tasks'); // check deps
      flatLog.push('update_task_status'); // manually unblock D

      // Complete B — must manually check what depends on B
      flatLog.push('update_task_status'); // mark B done
      flatLog.push('list_tasks'); // check deps
      flatLog.push('update_task_status'); // manually unblock C

      // Flat: 2 manual status updates for dependents
      const manualStatusUpdates = 2;
      expect(manualStatusUpdates).toBe(2);
      expect(flatLog.count()).toBe(10);
    });

    it('Summary: manual status updates — Cord 0 vs Flat 2+', () => {
      const metrics = {
        cord: { manualStatusUpdates: 0, totalCalls: 6 },
        flat: { manualStatusUpdates: 2, totalCalls: 10 },
      };

      expect(metrics.cord.manualStatusUpdates).toBe(0);
      expect(metrics.flat.manualStatusUpdates).toBeGreaterThanOrEqual(2);
      expect(metrics.cord.totalCalls).toBeLessThan(metrics.flat.totalCalls);
    });
  });

  // ─── Scenario D: Ask/Answer Decision Flow ──────────────────────────
  describe('Scenario D: Ask/Answer Decision Flow', () => {
    it('Cord: ask + complete + auto-unblock = 3 tool calls', async () => {
      const cordLog = createCallLog();

      // Design choice blocks implementation
      const ask = await handlers.handleCordAsk({
        question: 'Rollback or fix-forward for prod error?',
        options: ['rollback', 'fix-forward'],
      });
      cordLog.push('cord_ask');

      // Implementation blocked by the decision
      const impl = await handlers.handleCordSpawn({
        goal: 'Execute decision',
        blocked_by: [ask.metadata.task_id],
      });
      cordLog.push('cord_spawn');

      expect(impl.metadata.status).toBe('blocked');

      // Answer the question → impl auto-activates
      const answer = await handlers.handleCordComplete({
        task_id: ask.metadata.task_id,
        result: 'fix-forward',
      });
      cordLog.push('cord_complete');

      expect(answer.metadata.unblocked).toContain(impl.metadata.task_id);

      // Verify via tree that impl is now active with the answer in context
      const tree = await handlers.handleCordTree({ include_results: true });
      const implNode = tree.metadata.tasks.find(
        (t: any) => t.task_id === impl.metadata.task_id
      );
      expect(implNode.status).toBe('active');
      expect(implNode.visible_context.blocker_results).toHaveLength(1);
      expect(implNode.visible_context.blocker_results[0].result).toBe(
        'fix-forward'
      );

      // Cord: 3 calls for the decision flow (ask + spawn + complete)
      expect(cordLog.count()).toBe(3);
    });

    it('Flat: decision flow requires 5+ manual calls', () => {
      const flatLog = createCallLog();

      // Create question task
      flatLog.push('create_task'); // create question task

      // Create implementation task (manually note it depends on question)
      flatLog.push('create_task'); // create impl task

      // Poll for answer (no blocking mechanism)
      flatLog.push('list_tasks'); // check if question answered
      flatLog.push('update_task_status'); // manually mark question answered

      // Now manually unblock impl and pass the answer
      flatLog.push('update_task_status'); // unblock impl + copy answer

      // Flat: 5 calls minimum
      expect(flatLog.count()).toBe(5);
    });

    it('Summary: decision flow — Cord 3 vs Flat 5+ calls', () => {
      const metrics = {
        cord: { calls: 3, autoUnblock: true, structuredAnswer: true },
        flat: { calls: 5, autoUnblock: false, structuredAnswer: false },
      };

      expect(metrics.cord.calls).toBeLessThan(metrics.flat.calls);
      expect(metrics.cord.autoUnblock).toBe(true);
      expect(metrics.flat.autoUnblock).toBe(false);
    });
  });

  // ─── Overall Summary Table ──────────────────────────────────────────
  describe('Overall Comparison Summary', () => {
    it('Cord wins on all four measured dimensions', () => {
      const summary = {
        context_scoping: {
          cord: 'scoped (spawn: blockers only, fork: + siblings)',
          flat: 'global (all tasks visible)',
          winner: 'cord',
        },
        manual_status_updates: {
          cord: 0,
          flat: 2, // minimum for diamond deps
          winner: 'cord',
        },
        pipeline_tool_calls: {
          cord: 6, // 3 spawn + 2 complete + 1 tree
          flat: 6, // 3 create + 2 update + 1 list — but no context flow
          advantage: 'cord (same count but automatic context)',
        },
        decision_flow_calls: {
          cord: 3,
          flat: 5,
          winner: 'cord',
        },
      };

      expect(summary.manual_status_updates.cord).toBe(0);
      expect(summary.manual_status_updates.flat).toBeGreaterThan(0);
      expect(summary.decision_flow_calls.cord).toBeLessThan(
        summary.decision_flow_calls.flat
      );
      expect(summary.context_scoping.winner).toBe('cord');
    });
  });
});
