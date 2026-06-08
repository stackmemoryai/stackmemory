/**
 * StackMemory Vision tests — VISION.md parsing, signal inbox, and the loop's
 * selection / guardrail / brain-dedupe / delegation behavior.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseVision, scaffoldVision, setObjectiveDone } from '../vision-file.js';
import { SignalInbox } from '../signals.js';
import { VisionLoop, type BrainPort, type Delegate } from '../vision-loop.js';
import type { Candidate, DelegationOutcome } from '../types.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vision-test-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const SAMPLE = `# Vision

Ship a reliable sync layer.

## Guardrails

- never touch production secrets
- open a PR for review

## Scope

- src/**

## Objectives

- [ ] add retry with jitter
- [x] write the protocol types
- [ ] add a status command

## Limits

maxIterations: 5
maxConsecutiveFailures: 2
requireApproval: false
`;

describe('parseVision', () => {
  it('parses mission, guardrails, scope, objectives, and limits', () => {
    const v = parseVision(SAMPLE);
    expect(v.mission).toBe('Ship a reliable sync layer.');
    expect(v.guardrails).toEqual([
      'never touch production secrets',
      'open a PR for review',
    ]);
    expect(v.scope).toEqual(['src/**']);
    expect(v.objectives).toHaveLength(3);
    expect(v.objectives[1].done).toBe(true);
    expect(v.objectives[0].done).toBe(false);
    expect(v.limits.maxIterations).toBe(5);
    expect(v.limits.maxConsecutiveFailures).toBe(2);
    expect(v.limits.requireApproval).toBe(false);
  });

  it('falls back to default limits when omitted', () => {
    const v = parseVision('# Vision\n\nDo a thing.\n');
    expect(v.limits.maxIterations).toBeGreaterThan(0);
    expect(v.objectives).toHaveLength(0);
  });
});

describe('scaffold + toggle', () => {
  it('scaffolds a template and does not overwrite without force', () => {
    const p = join(dir, 'VISION.md');
    expect(scaffoldVision(p)).toBe(true);
    expect(scaffoldVision(p)).toBe(false);
    expect(scaffoldVision(p, true)).toBe(true);
    expect(readFileSync(p, 'utf-8')).toContain('## Objectives');
  });

  it('toggles an objective checkbox by id', () => {
    const p = join(dir, 'VISION.md');
    writeFileSync(p, SAMPLE);
    const v = parseVision(SAMPLE);
    const target = v.objectives[0];
    expect(setObjectiveDone(p, target.id, true)).toBe(true);
    const after = parseVision(readFileSync(p, 'utf-8'));
    expect(after.objectives.find((o) => o.id === target.id)?.done).toBe(true);
  });
});

describe('SignalInbox', () => {
  it('adds and returns pending signals severity-then-age ordered', () => {
    const inbox = new SignalInbox(join(dir, 'signals.jsonl'));
    inbox.add({ text: 'low thing', severity: 'low' });
    inbox.add({ text: 'critical thing', severity: 'critical' });
    inbox.add({ text: 'medium thing', severity: 'medium' });
    const pending = inbox.pending();
    expect(pending[0].text).toBe('critical thing');
    expect(pending).toHaveLength(3);
  });

  it('resolves a signal so it drops out of pending', () => {
    const inbox = new SignalInbox(join(dir, 'signals.jsonl'));
    const s = inbox.add({ text: 'fix me' });
    expect(inbox.resolve(s.id)).toBe(true);
    expect(inbox.pending()).toHaveLength(0);
  });
});

// --- Loop ---

class FakeBrain implements BrainPort {
  entries: Array<{ title: string; conclusion: string }> = [];
  recall(q: { text?: string }) {
    if (!q.text) return this.entries;
    return this.entries.filter(
      (e) => e.title.includes(q.text!) || q.text!.includes(e.title)
    );
  }
  record(input: { title: string; conclusion?: string }) {
    this.entries.push({ title: input.title, conclusion: input.conclusion ?? '' });
    return undefined;
  }
}

function makeLoop(brain: BrainPort, delegate: Delegate) {
  const visionPath = join(dir, 'VISION.md');
  writeFileSync(visionPath, SAMPLE);
  return {
    visionPath,
    loop: new VisionLoop({
      visionPath,
      statePath: join(dir, 'state.json'),
      signalsPath: join(dir, 'signals.jsonl'),
      brain,
      delegate,
      sleep: async () => {},
    }),
  };
}

describe('VisionLoop', () => {
  it('prioritizes pending signals over objectives', async () => {
    const brain = new FakeBrain();
    const seen: Candidate[] = [];
    const delegate: Delegate = async (c) => {
      seen.push(c);
      return { success: true, conclusion: 'done' };
    };
    const { loop, visionPath } = makeLoop(brain, delegate);
    new SignalInbox(join(dir, 'signals.jsonl')).add({
      text: 'urgent prod bug',
      severity: 'critical',
    });

    const d = await loop.tick(0);
    expect(d.candidate?.kind).toBe('signal');
    expect(d.candidate?.text).toBe('urgent prod bug');
    expect(d.delegated).toBe(true);
    // brain recorded the outcome
    expect(brain.entries.some((e) => e.title === 'urgent prod bug')).toBe(true);
    expect(visionPath).toBeTruthy();
  });

  it('falls back to the next undone objective when no signals', async () => {
    const brain = new FakeBrain();
    const delegate: Delegate = async () => ({ success: true, conclusion: 'ok' });
    const { loop } = makeLoop(brain, delegate);
    const d = await loop.tick(0);
    expect(d.candidate?.kind).toBe('objective');
    expect(d.candidate?.text).toBe('add retry with jitter'); // first undone
  });

  it('skips work the brain already concluded (no repeats)', async () => {
    const brain = new FakeBrain();
    brain.entries.push({ title: 'add retry with jitter', conclusion: 'shipped last week' });
    const delegate = vi.fn<Delegate>(async () => ({ success: true, conclusion: 'x' }));
    const { loop } = makeLoop(brain, delegate);

    const d = await loop.tick(0);
    expect(d.skippedAsKnown).toBe(true);
    expect(d.priorConclusion).toBe('shipped last week');
    expect(delegate).not.toHaveBeenCalled();
  });

  it('does not delegate in dry-run / plan mode', async () => {
    const brain = new FakeBrain();
    const delegate = vi.fn<Delegate>(async () => ({ success: true, conclusion: 'x' }));
    const { loop } = makeLoop(brain, delegate);
    const d = await loop.tick(0, true);
    expect(d.candidate).toBeTruthy();
    expect(d.delegated).toBe(false);
    expect(delegate).not.toHaveBeenCalled();
  });

  it('stops via the consecutive-failure circuit breaker', async () => {
    const brain = new FakeBrain();
    let n = 0;
    const delegate: Delegate = async () => {
      n++;
      return { success: false, conclusion: 'boom' };
    };
    // Two distinct objectives fail, then the breaker (limit 2) trips.
    const { loop } = makeLoop(brain, delegate);
    const result = await loop.run({ maxIterations: 5 });
    expect(result.stopped).toContain('circuit breaker');
    // delegated twice before the breaker stopped it on the 3rd tick
    expect(n).toBe(2);
  });

  it('marks objectives done on success and advances', async () => {
    const brain = new FakeBrain();
    const delegate: Delegate = async () => ({ success: true, conclusion: 'done' });
    const { loop, visionPath } = makeLoop(brain, delegate);
    await loop.run({ maxIterations: 5 });
    const after = parseVision(readFileSync(visionPath, 'utf-8'));
    // Both initially-undone objectives should now be checked.
    expect(after.objectives.every((o) => o.done)).toBe(true);
  });

  it('reports a hard stop when VISION.md is missing', async () => {
    const brain = new FakeBrain();
    const loop = new VisionLoop({
      visionPath: join(dir, 'nope.md'),
      statePath: join(dir, 'state.json'),
      signalsPath: join(dir, 'signals.jsonl'),
      brain,
      delegate: async () => ({ success: true, conclusion: '' }),
      sleep: async () => {},
    });
    const d = await loop.tick(0);
    expect(d.guardrail.ok).toBe(false);
    expect(d.guardrail.reason).toContain('VISION.md');
  });
});
