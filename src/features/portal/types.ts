/**
 * StackMemory Portal — types
 *
 * The portal is a self-hosted, browser-based terminal into a persistent
 * tmux session running Claude Code. It is designed to run on a small VPS
 * (e.g. Hetzner CX) behind a Tailscale VPN so your agents can run 24/7
 * while you check in from any device.
 */

export interface PortalConfig {
  /** Port the HTTP/WebSocket server listens on. Default: 7799 */
  port: number;
  /** Interface to bind to. Default: 0.0.0.0 (reachable over the tailnet). */
  host: string;
  /** tmux session name that hosts Claude Code. Default: "claude" */
  session: string;
  /**
   * Command tmux runs inside the session. Default: "claude".
   * Passed verbatim to `tmux new-session` (tmux runs it via the user shell),
   * so "claude --resume" or a custom wrapper both work.
   */
  command: string;
  /** Working directory for the tmux session. Default: process.cwd() */
  cwd: string;
  /**
   * Shared access token. When set, clients must present it via the
   * `?token=` query string (page load) or socket handshake. Auto-generated
   * and persisted on first start if not provided.
   */
  token: string;
  /** Disable token auth entirely (rely on Tailscale only). Default: false */
  noAuth: boolean;
}

export const DEFAULT_PORTAL_CONFIG: Omit<PortalConfig, 'cwd' | 'token'> = {
  port: 7799,
  host: '0.0.0.0',
  session: 'claude',
  command: 'claude',
  noAuth: false,
};

export interface PortalStatus {
  running: boolean;
  pid?: number;
  port?: number;
  host?: string;
  session?: string;
  startedAt?: number;
}
