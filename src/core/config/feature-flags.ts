/**
 * Feature Flags Configuration
 * Controls which external integrations are enabled
 *
 * Set STACKMEMORY_LOCAL=true to run without any external services
 */

export interface FeatureFlags {
  // Core features (always available)
  core: true;

  // External integrations (can be disabled)
  linear: boolean;
  aiSummaries: boolean;
  skills: boolean;
  ralph: boolean;
  multiProvider: boolean;
}

/**
 * Check if running in local-only mode
 * When true, all external service integrations are disabled
 */
export function isLocalOnly(): boolean {
  return (
    process.env['STACKMEMORY_LOCAL'] === 'true' ||
    process.env['STACKMEMORY_LOCAL'] === '1' ||
    process.env['LOCAL_ONLY'] === 'true'
  );
}

/**
 * Check if a specific feature is enabled
 */
export function isFeatureEnabled(feature: keyof FeatureFlags): boolean {
  if (feature === 'core') return true;

  // In local-only mode, external integrations are disabled
  if (isLocalOnly()) return false;

  // Check feature-specific env vars
  switch (feature) {
    case 'linear':
      return (
        process.env['STACKMEMORY_LINEAR'] !== 'false' &&
        (!!process.env['LINEAR_API_KEY'] || !!process.env['LINEAR_OAUTH_TOKEN'])
      );
    case 'aiSummaries':
      return (
        process.env['STACKMEMORY_AI'] !== 'false' &&
        (!!process.env['ANTHROPIC_API_KEY'] || !!process.env['OPENAI_API_KEY'])
      );
    case 'skills':
      // Skills enabled explicitly or when AI summaries available
      return (
        process.env['STACKMEMORY_SKILLS'] === 'true' ||
        process.env['STACKMEMORY_SKILLS'] === '1'
      );
    case 'ralph':
      // Ralph enabled by default in development (unless explicitly disabled)
      // For npm package users, must be explicitly enabled
      return process.env['STACKMEMORY_RALPH'] !== 'false';
    case 'multiProvider':
      return (
        process.env['STACKMEMORY_MULTI_PROVIDER'] === 'true' ||
        process.env['STACKMEMORY_MULTI_PROVIDER'] === '1'
      );
    default:
      return false;
  }
}

/**
 * Get all feature flags
 */
export function getFeatureFlags(): FeatureFlags {
  return {
    core: true,
    linear: isFeatureEnabled('linear'),
    aiSummaries: isFeatureEnabled('aiSummaries'),
    skills: isFeatureEnabled('skills'),
    ralph: isFeatureEnabled('ralph'),
    multiProvider: isFeatureEnabled('multiProvider'),
  };
}

/**
 * Log feature flags status (for debugging)
 */
export function logFeatureStatus(): void {
  const flags = getFeatureFlags();
  const local = isLocalOnly();

  console.log(
    `StackMemory Mode: ${local ? 'LOCAL (no external services)' : 'FULL'}`
  );
  if (!local) {
    console.log(
      `  Linear: ${flags.linear ? 'enabled' : 'disabled (no API key)'}`
    );
    console.log(
      `  AI Summaries: ${flags.aiSummaries ? 'enabled' : 'disabled (no API key)'}`
    );
    console.log(
      `  Skills: ${flags.skills ? 'enabled' : 'disabled (set STACKMEMORY_SKILLS=true)'}`
    );
    console.log(
      `  Ralph: ${flags.ralph ? 'enabled' : 'disabled (set STACKMEMORY_RALPH=true)'}`
    );
    console.log(
      `  MultiProvider: ${flags.multiProvider ? 'enabled' : 'disabled (set STACKMEMORY_MULTI_PROVIDER=true)'}`
    );
  }
}
