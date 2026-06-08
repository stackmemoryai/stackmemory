/**
 * StackMemory Portal — public API.
 *
 * A self-hosted, browser-based terminal into a persistent tmux session
 * running Claude Code. See docs/guides/PORTAL.md for the Hetzner + Tailscale
 * deployment guide.
 */

export {
  PortalServer,
  resolveConfig,
  ensureToken,
  readStatus,
  stopRunning,
  getPortalDir,
} from './server.js';
export { renderPortalPage } from './ui.js';
export {
  type PortalConfig,
  type PortalStatus,
  DEFAULT_PORTAL_CONFIG,
} from './types.js';
