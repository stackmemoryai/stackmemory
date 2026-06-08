/**
 * StackMemory Vision — VISION.md parsing, scaffolding, and objective toggling.
 *
 * VISION.md is plain markdown so it stays human-editable and reviewable:
 *
 *   # Vision
 *   <north-star mission paragraph>
 *
 *   ## Guardrails
 *   - never touch production credentials
 *   - keep changes within the documented scope
 *
 *   ## Scope
 *   - src/**
 *   - docs/**
 *
 *   ## Objectives
 *   - [ ] first objective
 *   - [x] a completed objective
 *
 *   ## Limits
 *   maxIterations: 10
 *   maxIterationsPerDay: 50
 *   requireApproval: false
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import {
  type Vision,
  type Objective,
  type VisionLimits,
  DEFAULT_LIMITS,
} from './types.js';

export function objectiveId(text: string): string {
  return createHash('sha1').update(text.trim()).digest('hex').slice(0, 10);
}

interface Section {
  body: string[];
}

function splitSections(text: string): {
  preamble: string[];
  sections: Map<string, Section>;
} {
  const lines = text.split(/\r?\n/);
  const sections = new Map<string, Section>();
  const preamble: string[] = [];
  let current: Section | null = null;

  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    if (h2) {
      current = { body: [] };
      sections.set(h2[1].toLowerCase(), current);
      continue;
    }
    if (/^#\s+/.test(line)) continue; // skip the H1 title
    if (current) {
      current.body.push(line);
    } else {
      preamble.push(line);
    }
  }
  return { preamble, sections };
}

function bulletLines(body: string[]): string[] {
  return body
    .map((l) => l.match(/^\s*[-*]\s+(.*\S)\s*$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => m[1].trim())
    .filter((s) => !/^\[[ xX]\]/.test(s)); // checklist handled separately
}

function parseObjectives(body: string[]): Objective[] {
  const objectives: Objective[] = [];
  for (const line of body) {
    const m = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*\S)\s*$/);
    if (!m) continue;
    const text = m[2].trim();
    objectives.push({
      id: objectiveId(text),
      text,
      done: m[1].toLowerCase() === 'x',
    });
  }
  return objectives;
}

function parseLimits(body: string[]): VisionLimits {
  const limits: VisionLimits = { ...DEFAULT_LIMITS };
  for (const line of body) {
    const m = line.match(/^\s*([a-zA-Z]+)\s*:\s*(.+?)\s*$/);
    if (!m) continue;
    const key = m[1] as keyof VisionLimits;
    const raw = m[2];
    if (!(key in limits)) continue;
    if (key === 'requireApproval' || key === 'stopWhenComplete') {
      (limits[key] as boolean) = /^(true|yes|1)$/i.test(raw);
    } else {
      const n = parseInt(raw, 10);
      if (Number.isFinite(n)) (limits[key] as number) = n;
    }
  }
  return limits;
}

export function parseVision(text: string): Vision {
  const { preamble, sections } = splitSections(text);
  const body = (name: string): string[] => sections.get(name)?.body ?? [];
  const mission = preamble
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ')
    .trim();
  return {
    mission,
    guardrails: bulletLines(body('guardrails')),
    scope: bulletLines(body('scope')),
    objectives: parseObjectives(body('objectives')),
    limits: sections.has('limits')
      ? parseLimits(body('limits'))
      : { ...DEFAULT_LIMITS },
  };
}

export function loadVision(path: string): Vision | null {
  if (!existsSync(path)) return null;
  return parseVision(readFileSync(path, 'utf-8'));
}

/** Flip an objective's checkbox in place, preserving the rest of the file. */
export function setObjectiveDone(
  path: string,
  objId: string,
  done: boolean
): boolean {
  if (!existsSync(path)) return false;
  const lines = readFileSync(path, 'utf-8').split(/\r?\n/);
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*[-*]\s+)\[([ xX])\]\s+(.*\S)\s*$/);
    if (!m) continue;
    if (objectiveId(m[3].trim()) === objId) {
      lines[i] = `${m[1]}[${done ? 'x' : ' '}] ${m[3].trim()}`;
      changed = true;
      break;
    }
  }
  if (changed) writeFileSync(path, lines.join('\n'));
  return changed;
}

export const VISION_TEMPLATE = `# Vision

State the single north-star mission this autonomous loop serves. Keep it to a
sentence or two — concrete enough to judge whether a piece of work belongs.

## Guardrails

- Stay within the scope below; do not touch anything outside it.
- Never modify secrets, production credentials, or deploy/publish.
- Open a PR for review; never merge to the default branch autonomously.
- If an objective is ambiguous or risky, stop and ask a human.

## Scope

- src/**
- docs/**

## Objectives

- [ ] First concrete objective the loop should pursue
- [ ] Second objective
- [ ] Third objective

## Limits

maxIterations: 10
maxIterationsPerDay: 50
maxConsecutiveFailures: 3
tickIntervalSec: 60
requireApproval: false
stopWhenComplete: true
`;

export function scaffoldVision(path: string, force = false): boolean {
  if (existsSync(path) && !force) return false;
  writeFileSync(path, VISION_TEMPLATE);
  return true;
}
