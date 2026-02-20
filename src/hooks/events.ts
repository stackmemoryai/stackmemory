/**
 * StackMemory Hook Events
 * Event types and emitter for the hook system
 */

import { EventEmitter } from 'events';

export type HookEventType =
  | 'input_idle'
  | 'file_change'
  | 'context_switch'
  | 'session_start'
  | 'session_end'
  | 'prompt_submit'
  | 'tool_use'
  | 'suggestion_ready'
  | 'agent_start'
  | 'agent_complete'
  | 'agent_error'
  | 'error';

export interface HookEvent {
  type: HookEventType;
  timestamp: number;
  data: Record<string, unknown>;
}

export interface FileChangeEvent extends HookEvent {
  type: 'file_change';
  data: {
    path: string;
    changeType: 'create' | 'modify' | 'delete';
    content?: string;
  };
}

export interface InputIdleEvent extends HookEvent {
  type: 'input_idle';
  data: {
    idleDuration: number;
    lastInput?: string;
  };
}

export interface ContextSwitchEvent extends HookEvent {
  type: 'context_switch';
  data: {
    fromBranch?: string;
    toBranch?: string;
    fromProject?: string;
    toProject?: string;
  };
}

export interface SuggestionReadyEvent extends HookEvent {
  type: 'suggestion_ready';
  data: {
    suggestion: string;
    source: string;
    confidence?: number;
    preview?: string;
  };
}

export type AgentType = 'research' | 'maintain' | 'spec-run';

export interface AgentStartEvent extends HookEvent {
  type: 'agent_start';
  data: { agentType: AgentType; workDir: string; task: string };
}

export interface AgentCompleteEvent extends HookEvent {
  type: 'agent_complete';
  data: {
    agentType: AgentType;
    workDir: string;
    exitCode: number | null;
    timedOut: boolean;
    frameId?: string;
    patchPath?: string;
    validated?: boolean;
    branch?: string;
    validation?: { lint: boolean; test: boolean; build: boolean };
  };
}

export interface AgentErrorEvent extends HookEvent {
  type: 'agent_error';
  data: { agentType: AgentType; error: string; workDir?: string };
}

export type HookEventData =
  | FileChangeEvent
  | InputIdleEvent
  | ContextSwitchEvent
  | SuggestionReadyEvent
  | AgentStartEvent
  | AgentCompleteEvent
  | AgentErrorEvent
  | HookEvent;

export type HookHandler = (event: HookEventData) => Promise<void> | void;

export class HookEventEmitter extends EventEmitter {
  private handlers: Map<HookEventType, Set<HookHandler>> = new Map();

  registerHandler(eventType: HookEventType, handler: HookHandler): void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }
    const handlers = this.handlers.get(eventType);
    if (handlers) {
      handlers.add(handler);
    }
    this.on(eventType, handler);
  }

  unregisterHandler(eventType: HookEventType, handler: HookHandler): void {
    const handlers = this.handlers.get(eventType);
    if (handlers) {
      handlers.delete(handler);
      this.off(eventType, handler);
    }
  }

  async emitHook(event: HookEventData): Promise<void> {
    const handlers = this.handlers.get(event.type);
    if (!handlers || handlers.size === 0) {
      return;
    }

    const promises: Promise<void>[] = [];
    for (const handler of handlers) {
      try {
        const result = handler(event);
        if (result instanceof Promise) {
          promises.push(result);
        }
      } catch (error) {
        this.emit('error', {
          type: 'error',
          timestamp: Date.now(),
          data: { error, originalEvent: event },
        });
      }
    }

    await Promise.allSettled(promises);
  }

  getRegisteredEvents(): HookEventType[] {
    return Array.from(this.handlers.keys()).filter(
      (type) => (this.handlers.get(type)?.size ?? 0) > 0
    );
  }
}

export const hookEmitter = new HookEventEmitter();
