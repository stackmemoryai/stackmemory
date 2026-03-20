import type { SourceAdapter } from '../adapters/adapter.js';
import { ManualAdapter } from '../adapters/manual.js';
import { LinearAdapter } from '../adapters/linear.js';
import { SlackAdapter } from '../adapters/slack.js';
import { GitHubAdapter } from '../adapters/github.js';

const adapters = new Map<string, SourceAdapter>();

// Register built-in adapters
adapters.set('manual', new ManualAdapter());

// Register Linear if API key is available
const linear = LinearAdapter.fromEnv();
if (linear) {
  adapters.set('linear', linear);
}

// Register Slack if bot token is available
const slack = SlackAdapter.fromEnv();
if (slack) {
  adapters.set('slack', slack);
}

// Register GitHub if token and repo are available
const github = GitHubAdapter.fromEnv();
if (github) {
  adapters.set('github', github);
}

export function registerAdapter(adapter: SourceAdapter): void {
  adapters.set(adapter.system, adapter);
}

export function getAdapter(system: string): SourceAdapter | undefined {
  return adapters.get(system);
}

export function listAdapters(): string[] {
  return [...adapters.keys()];
}
