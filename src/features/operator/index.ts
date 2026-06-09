/**
 * Operator — Autonomous Claude Code driver
 *
 * Drives interactive Claude Code sessions via screen reading + keystroke injection.
 * Three adapter modes: tmux (CLI), desktop (macOS), browser (Playwright).
 */

export type {
  OperatorState,
  OperatorAction,
  OperatorConfig,
  OperatorCheckpoint,
  OperatorSummary,
  ScreenAdapter,
  AdapterMode,
  DetectionResult,
} from './types.js';

export { TmuxAdapter, ScreenshotAdapter } from './screen-adapter.js';
export { DesktopAdapter } from './desktop-adapter.js';
export { BrowserAdapter } from './browser-adapter.js';
export { createAdapter } from './adapter-factory.js';

export {
  detectState,
  decideAction,
  detectCompletion,
} from './state-machine.js';
export {
  classifyScreenState,
  generateNudge,
  generateRecoveryPrompt,
} from './llm-decision.js';
export type { LLMDecisionConfig } from './llm-decision.js';

export { TaskQueue } from './task-queue.js';
export { SessionManager } from './session-manager.js';
export { OvernightRunner } from './overnight-runner.js';
export { OperatorLogger } from './operator-logger.js';
