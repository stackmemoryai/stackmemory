/**
 * LLM Decision Layer
 *
 * Haiku-powered fallback for when regex detection can't determine state.
 * Used for: screenshot interpretation, ambiguous states, prodding stuck sessions.
 *
 * The outer loop LLM is intentionally cheap (Haiku) — it only needs to:
 * 1. Classify screen state from text/screenshot
 * 2. Decide if Claude needs a nudge
 * 3. Craft a recovery prompt when stuck
 */

import type {
  OperatorState,
  DetectionResult,
  OperatorCheckpoint,
} from './types.js';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

export interface LLMDecisionConfig {
  apiKey: string;
  model?: string; // default: claude-haiku-4-5-20251001
  maxTokens?: number;
}

interface MessageContent {
  type: 'text' | 'image';
  text?: string;
  source?: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

// ── State Classification ──────────────────────────────────

const CLASSIFY_SYSTEM = `You are a screen state classifier for Claude Code CLI sessions.
Given screen content (text or screenshot), classify the state as exactly one of:
IDLE, WORKING, PERMISSION_PROMPT, ERROR, COMPLETE, STUCK, RATE_LIMITED, SESSION_ENDED, UNKNOWN

Respond with ONLY a JSON object:
{"state": "<STATE>", "confidence": "high"|"medium"|"low", "detail": "<brief reason>"}

Rules:
- PERMISSION_PROMPT: Claude is asking for user approval (Y/n, Allow, Proceed?)
- RATE_LIMITED: usage limit, rate limit, 429, "try again"
- SESSION_ENDED: shell prompt visible, process exited, no Claude session
- ERROR: error message not inside a code block or file read
- IDLE: Claude's ">" prompt visible, waiting for input
- WORKING: Claude is reading files, searching, running commands
- COMPLETE: task finished, "TASK COMPLETE" visible
- STUCK: same content repeated, no progress indicators
- UNKNOWN: cannot determine`;

export async function classifyScreenState(
  content: string | { base64: string; mediaType: string },
  config: LLMDecisionConfig
): Promise<DetectionResult> {
  const userContent: MessageContent[] = [];

  if (typeof content === 'string') {
    userContent.push({
      type: 'text',
      text: `Screen content:\n${content.slice(-3000)}`,
    });
  } else {
    userContent.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: content.mediaType,
        data: content.base64,
      },
    });
    userContent.push({
      type: 'text',
      text: 'Classify the state of this Claude Code session screenshot.',
    });
  }

  try {
    const response = await callHaiku(config, CLASSIFY_SYSTEM, userContent);
    const parsed = JSON.parse(response);
    return {
      state: parsed.state as OperatorState,
      confidence: parsed.confidence ?? 'medium',
      detail: parsed.detail,
    };
  } catch {
    return {
      state: 'UNKNOWN',
      confidence: 'low',
      detail: 'LLM classification failed',
    };
  }
}

// ── Nudge Generation ──────────────────────────────────────

const NUDGE_SYSTEM = `You are an operator for an autonomous Claude Code session.
The inner Claude session appears stuck or going in circles.

Given the recent screen content and task context, generate a SHORT nudge message
(1-3 sentences) to get Claude back on track. Be direct and specific.

Examples of good nudges:
- "The tests are failing because of a missing import. Try: import { Foo } from './foo.js'"
- "You've been editing the same file for 5 minutes. Run the tests to check progress."
- "Stop investigating — just fix the type error on line 42 and move on."

Respond with ONLY the nudge text, no JSON wrapper.`;

export async function generateNudge(
  screenContent: string,
  taskDescription: string,
  config: LLMDecisionConfig
): Promise<string | undefined> {
  const prompt = `Task: ${taskDescription}\n\nRecent screen:\n${screenContent.slice(-2000)}`;

  try {
    return await callHaiku(config, NUDGE_SYSTEM, [
      { type: 'text', text: prompt },
    ]);
  } catch {
    return undefined;
  }
}

// ── Recovery Prompt Generation ────────────────────────────

const RECOVERY_SYSTEM = `You are an operator for an autonomous Claude Code session.
The session has encountered an error or is blocked.

Given the error context, generate a recovery prompt that Claude can use to fix the issue.
Be specific: name files, error messages, and concrete next steps.

Respond with ONLY the recovery prompt text.`;

export async function generateRecoveryPrompt(
  screenContent: string,
  errorDetail: string,
  checkpoint: OperatorCheckpoint,
  config: LLMDecisionConfig
): Promise<string | undefined> {
  const context = [
    `Error: ${errorDetail}`,
    `Current task: ${checkpoint.currentTaskId ?? 'none'}`,
    `Restarts so far: ${checkpoint.totalRestarts}`,
    `\nRecent screen:\n${screenContent.slice(-2000)}`,
  ].join('\n');

  try {
    return await callHaiku(config, RECOVERY_SYSTEM, [
      { type: 'text', text: context },
    ]);
  } catch {
    return undefined;
  }
}

// ── API Call ──────────────────────────────────────────────

async function callHaiku(
  config: LLMDecisionConfig,
  system: string,
  content: MessageContent[]
): Promise<string> {
  const model = config.model ?? 'claude-haiku-4-5-20251001';
  const maxTokens = config.maxTokens ?? 256;

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Haiku API ${response.status}: ${await response.text()}`);
  }

  const data = (await response.json()) as { content: Array<{ text: string }> };
  return data.content[0]?.text ?? '';
}
