/**
 * Parallel Agent Skill — Willison Patterns
 *
 * Spawns isolated Claude agents in disposable /tmp workspaces for:
 * - research: explore codebase + save findings as a frame
 * - maintain: low-stakes fixes, produces a .patch
 * - specRun: implement a spec on a branch, validate with lint+test+build
 */

import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { logger } from '../core/monitoring/logger.js';
import { hookEmitter } from '../hooks/events.js';
import type { SkillContext, SkillResult } from './claude-skills.js';

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  workDir: string;
  timedOut: boolean;
}

export interface AgentOptions {
  timeout?: number; // ms, default 5 min
}

const DEFAULT_TIMEOUT = 5 * 60 * 1000; // 5 minutes

/**
 * Spawn a Claude agent in a disposable git clone.
 *
 * 1. mkdtemp in /tmp
 * 2. git clone --depth=1 . <tmp>
 * 3. claude --print -p "<prompt>" in the clone
 * 4. Returns stdout/stderr/exitCode/workDir
 */
function spawnAgent(
  prompt: string,
  opts: { prefix: string; timeout: number; repoRoot: string }
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    let workDir: string;
    try {
      workDir = fs.mkdtempSync(path.join('/tmp', `${opts.prefix}-`));
    } catch (err) {
      return reject(
        new Error(`Failed to create temp dir: ${(err as Error).message}`)
      );
    }

    try {
      execSync(`git clone --depth=1 "${opts.repoRoot}" "${workDir}"`, {
        stdio: 'pipe',
        timeout: 30_000,
      });
    } catch (err) {
      cleanupDir(workDir);
      return reject(new Error(`git clone failed: ${(err as Error).message}`));
    }

    const child: ChildProcess = spawn('claude', ['--print'], {
      cwd: workDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
    }, opts.timeout);

    if (child.stdout) {
      child.stdout.on('data', (d: Buffer) => (stdout += d));
    }
    if (child.stderr) {
      child.stderr.on('data', (d: Buffer) => (stderr += d));
    }

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code, workDir, timedOut: killed });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: err.message,
        exitCode: 1,
        workDir,
        timedOut: false,
      });
    });

    if (child.stdin) {
      child.stdin.write(prompt);
      child.stdin.end();
    }
  });
}

function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

export class ParallelAgentSkill {
  private repoRoot: string;

  constructor(private context: SkillContext) {
    this.repoRoot = process.cwd();
  }

  /**
   * Research — explore codebase, save findings as a frame.
   */
  async research(
    question: string,
    options?: AgentOptions
  ): Promise<SkillResult> {
    if (!question?.trim()) {
      return { success: false, message: 'Question is required' };
    }

    const timeout = options?.timeout ?? DEFAULT_TIMEOUT;
    const prompt = [
      'Explore this codebase and answer the following question.',
      'Do NOT modify any files. Output your findings as structured markdown.',
      '',
      `Question: ${question}`,
    ].join('\n');

    let result: SpawnResult;
    try {
      hookEmitter
        .emitHook({
          type: 'agent_start',
          timestamp: Date.now(),
          data: { agentType: 'research', workDir: '', task: question },
        })
        .catch(() => {});
      result = await spawnAgent(prompt, {
        prefix: 'sm-research',
        timeout,
        repoRoot: this.repoRoot,
      });
    } catch (err) {
      const msg = (err as Error).message;
      hookEmitter
        .emitHook({
          type: 'agent_error',
          timestamp: Date.now(),
          data: { agentType: 'research', error: msg },
        })
        .catch(() => {});
      return {
        success: false,
        message: `Agent failed to start: ${msg}`,
      };
    }

    try {
      if (result.timedOut) {
        hookEmitter
          .emitHook({
            type: 'agent_complete',
            timestamp: Date.now(),
            data: {
              agentType: 'research',
              workDir: result.workDir,
              exitCode: result.exitCode,
              timedOut: true,
            },
          })
          .catch(() => {});
        return {
          success: false,
          message: `Research agent timed out after ${timeout / 1000}s`,
          data: { partial: result.stdout.slice(0, 2000) },
        };
      }

      const findings = result.stdout || '(no output)';

      // Save as a StackMemory frame
      let frameId: string | undefined;
      try {
        frameId = await this.saveFrame('research', question, findings);
      } catch (err) {
        logger.warn('Failed to save research frame:', err);
      }

      hookEmitter
        .emitHook({
          type: 'agent_complete',
          timestamp: Date.now(),
          data: {
            agentType: 'research',
            workDir: result.workDir,
            exitCode: result.exitCode,
            timedOut: false,
            frameId,
          },
        })
        .catch(() => {});

      return {
        success: true,
        message: `Research complete${frameId ? ` (frame: ${frameId})` : ''}`,
        data: { findings, frameId, exitCode: result.exitCode },
      };
    } finally {
      cleanupDir(result.workDir);
    }
  }

  /**
   * Maintain — low-stakes fix, produces a .patch file.
   */
  async maintain(task: string, options?: AgentOptions): Promise<SkillResult> {
    if (!task?.trim()) {
      return { success: false, message: 'Task description is required' };
    }

    const timeout = options?.timeout ?? DEFAULT_TIMEOUT;
    const prompt = [
      task,
      '',
      'After making changes, verify by running: npm run lint && npm run test:run',
    ].join('\n');

    let result: SpawnResult;
    try {
      hookEmitter
        .emitHook({
          type: 'agent_start',
          timestamp: Date.now(),
          data: { agentType: 'maintain', workDir: '', task },
        })
        .catch(() => {});
      result = await spawnAgent(prompt, {
        prefix: 'sm-maint',
        timeout,
        repoRoot: this.repoRoot,
      });
    } catch (err) {
      const msg = (err as Error).message;
      hookEmitter
        .emitHook({
          type: 'agent_error',
          timestamp: Date.now(),
          data: { agentType: 'maintain', error: msg },
        })
        .catch(() => {});
      return {
        success: false,
        message: `Agent failed to start: ${msg}`,
      };
    }

    try {
      if (result.timedOut) {
        hookEmitter
          .emitHook({
            type: 'agent_complete',
            timestamp: Date.now(),
            data: {
              agentType: 'maintain',
              workDir: result.workDir,
              exitCode: result.exitCode,
              timedOut: true,
            },
          })
          .catch(() => {});
        return {
          success: false,
          message: `Maintenance agent timed out after ${timeout / 1000}s`,
          data: { partial: result.stdout.slice(0, 2000) },
        };
      }

      // Extract diff from the workspace
      let diff = '';
      try {
        diff = execSync('git diff HEAD', {
          cwd: result.workDir,
          encoding: 'utf-8',
          timeout: 10_000,
        });
      } catch {
        // diff may fail if no changes
      }

      if (!diff.trim()) {
        hookEmitter
          .emitHook({
            type: 'agent_complete',
            timestamp: Date.now(),
            data: {
              agentType: 'maintain',
              workDir: result.workDir,
              exitCode: result.exitCode,
              timedOut: false,
            },
          })
          .catch(() => {});
        return {
          success: false,
          message: 'Agent made no changes (empty diff)',
          data: { output: result.stdout.slice(0, 2000) },
        };
      }

      // Validate patch with lint
      let validated = false;
      try {
        execSync('npm run lint', {
          cwd: result.workDir,
          stdio: 'pipe',
          timeout: 60_000,
        });
        validated = true;
      } catch {
        // lint failed — patch is unvalidated
      }

      // Write patch file
      const patchDir = path.join(this.repoRoot, '.stackmemory', 'patches');
      fs.mkdirSync(patchDir, { recursive: true });

      const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, '-')
        .slice(0, 19);
      const slug = slugify(task);
      const patchFile = `${timestamp}-${slug}.patch`;
      const patchPath = path.join(patchDir, patchFile);

      fs.writeFileSync(patchPath, diff);

      const diffLines = diff.split('\n');
      const filesChanged = diffLines.filter((l) =>
        l.startsWith('diff --git')
      ).length;
      const additions = diffLines.filter((l) => /^\+[^+]/.test(l)).length;
      const deletions = diffLines.filter((l) => /^-[^-]/.test(l)).length;

      hookEmitter
        .emitHook({
          type: 'agent_complete',
          timestamp: Date.now(),
          data: {
            agentType: 'maintain',
            workDir: result.workDir,
            exitCode: result.exitCode,
            timedOut: false,
            patchPath,
            validated,
          },
        })
        .catch(() => {});

      return {
        success: true,
        message: `Patch saved: ${patchFile}${validated ? '' : ' (lint failed)'}`,
        data: {
          patchPath,
          validated,
          filesChanged,
          additions,
          deletions,
          output: result.stdout.slice(0, 2000),
        },
        action: `Apply with: git apply ${patchPath}`,
      };
    } finally {
      cleanupDir(result.workDir);
    }
  }

  /**
   * SpecRun — implement a spec file on a branch, validate.
   */
  async specRun(
    specPath: string,
    options?: AgentOptions
  ): Promise<SkillResult> {
    if (!specPath?.trim()) {
      return { success: false, message: 'Spec file path is required' };
    }

    const absSpec = path.isAbsolute(specPath)
      ? specPath
      : path.join(this.repoRoot, specPath);

    if (!fs.existsSync(absSpec)) {
      return { success: false, message: `Spec file not found: ${specPath}` };
    }

    const specContent = fs.readFileSync(absSpec, 'utf-8');
    const timeout = options?.timeout ?? DEFAULT_TIMEOUT;

    const prompt = [
      'Implement the following specification. Follow it precisely.',
      '',
      '--- SPEC START ---',
      specContent,
      '--- SPEC END ---',
    ].join('\n');

    // Clone and create branch
    let workDir: string;
    try {
      workDir = fs.mkdtempSync(path.join('/tmp', 'sm-spec-'));
    } catch (err) {
      return {
        success: false,
        message: `Failed to create temp dir: ${(err as Error).message}`,
      };
    }

    try {
      execSync(`git clone --depth=1 "${this.repoRoot}" "${workDir}"`, {
        stdio: 'pipe',
        timeout: 30_000,
      });
    } catch (err) {
      const msg = (err as Error).message;
      cleanupDir(workDir);
      hookEmitter
        .emitHook({
          type: 'agent_error',
          timestamp: Date.now(),
          data: { agentType: 'spec-run', error: msg, workDir },
        })
        .catch(() => {});
      return {
        success: false,
        message: `git clone failed: ${msg}`,
      };
    }

    const branchName = `agent/spec-${Date.now()}`;
    try {
      execSync(`git checkout -b "${branchName}"`, {
        cwd: workDir,
        stdio: 'pipe',
        timeout: 5_000,
      });
    } catch (err) {
      const msg = (err as Error).message;
      cleanupDir(workDir);
      hookEmitter
        .emitHook({
          type: 'agent_error',
          timestamp: Date.now(),
          data: { agentType: 'spec-run', error: msg, workDir },
        })
        .catch(() => {});
      return {
        success: false,
        message: `Failed to create branch: ${msg}`,
      };
    }

    hookEmitter
      .emitHook({
        type: 'agent_start',
        timestamp: Date.now(),
        data: { agentType: 'spec-run', workDir, task: specPath },
      })
      .catch(() => {});

    // Run the agent
    const child: ChildProcess = spawn('claude', ['--print'], {
      cwd: workDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    const agentDone = new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number | null;
      timedOut: boolean;
    }>((resolve) => {
      const timer = setTimeout(() => {
        killed = true;
        child.kill('SIGTERM');
      }, timeout);

      if (child.stdout) {
        child.stdout.on('data', (d: Buffer) => (stdout += d));
      }
      if (child.stderr) {
        child.stderr.on('data', (d: Buffer) => (stderr += d));
      }

      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code, timedOut: killed });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          stdout,
          stderr: err.message,
          exitCode: 1,
          timedOut: false,
        });
      });
    });

    if (child.stdin) {
      child.stdin.write(prompt);
      child.stdin.end();
    }

    const agentResult = await agentDone;

    if (agentResult.timedOut) {
      // Don't clean up — user may want to inspect
      return {
        success: false,
        message: `Spec agent timed out after ${timeout / 1000}s`,
        data: {
          workDir,
          branch: branchName,
          partial: agentResult.stdout.slice(0, 2000),
        },
      };
    }

    // Validate
    const validation = { lint: false, test: false, build: false };
    try {
      execSync('npm run lint', {
        cwd: workDir,
        stdio: 'pipe',
        timeout: 60_000,
      });
      validation.lint = true;
    } catch {
      /* lint failed */
    }

    try {
      execSync('npm run test:run', {
        cwd: workDir,
        stdio: 'pipe',
        timeout: 120_000,
      });
      validation.test = true;
    } catch {
      /* test failed */
    }

    try {
      execSync('npm run build', {
        cwd: workDir,
        stdio: 'pipe',
        timeout: 60_000,
      });
      validation.build = true;
    } catch {
      /* build failed */
    }

    // Diff stats
    let diffStat = '';
    try {
      diffStat = execSync('git diff --stat HEAD~1', {
        cwd: workDir,
        encoding: 'utf-8',
        timeout: 5_000,
      });
    } catch {
      /* no commits yet */
    }

    const allPassed = validation.lint && validation.test && validation.build;

    hookEmitter
      .emitHook({
        type: 'agent_complete',
        timestamp: Date.now(),
        data: {
          agentType: 'spec-run',
          workDir,
          exitCode: agentResult.exitCode,
          timedOut: false,
          branch: branchName,
          validation,
        },
      })
      .catch(() => {});

    // Don't clean up spec workspace — user needs to review it
    return {
      success: allPassed,
      message: allPassed
        ? `Spec implemented on branch ${branchName}`
        : `Spec implemented but validation failed on branch ${branchName}`,
      data: {
        workDir,
        branch: branchName,
        validation,
        diffStat: diffStat.trim(),
        output: agentResult.stdout.slice(0, 2000),
      },
      action: allPassed
        ? `Review: cd ${workDir} && git log --oneline`
        : `Inspect: cd ${workDir} && git diff`,
    };
  }

  private async saveFrame(
    type: string,
    query: string,
    content: string
  ): Promise<string | undefined> {
    const db = this.context.database;
    if (!db) return undefined;

    const frameId = await db.createFrame({
      run_id: `agent-${Date.now()}`,
      project_id: this.context.projectId,
      type,
      name: `Agent ${type}: ${query.slice(0, 60)}`,
      state: 'completed',
      inputs: { query, agentType: type },
      digest_text: content,
    });

    return frameId;
  }
}
