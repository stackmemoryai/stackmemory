/**
 * Tool Alias Registry
 *
 * Maps common misspellings, abbreviations, and variant names to canonical
 * MCP tool names. Built from desire paths analysis — what agents try to call
 * vs what actually exists.
 *
 * Also handles parameter name aliases so agents can use common variants
 * (e.g., `query` vs `search_term`) and have them resolved transparently.
 */

export interface AliasResolution {
  /** The canonical tool name */
  canonicalName: string;
  /** Whether the name was an alias (false = already canonical) */
  wasAlias: boolean;
  /** The original name that was looked up */
  originalName: string;
}

export interface ParamResolution {
  /** Resolved parameters with canonical names */
  resolvedParams: Record<string, unknown>;
  /** Map of param renames that were applied: original -> canonical */
  renames: Record<string, string>;
}

/**
 * Static registry of tool name aliases.
 *
 * Key: alias name (what agents try to call)
 * Value: canonical tool name (what actually exists)
 *
 * Organized by category for readability.
 */
const TOOL_ALIASES: Record<string, string> = {
  // --- Context tools ---
  context: 'get_context',
  get_ctx: 'get_context',
  sm_context: 'get_context',
  sm_get_context: 'get_context',
  fetch_context: 'get_context',
  read_context: 'get_context',

  record_decision: 'add_decision',
  log_decision: 'add_decision',
  save_decision: 'add_decision',
  sm_decision: 'add_decision',

  push_frame: 'start_frame',
  open_frame: 'start_frame',
  begin_frame: 'start_frame',
  new_frame: 'start_frame',

  pop_frame: 'close_frame',
  end_frame: 'close_frame',
  finish_frame: 'close_frame',

  anchor: 'add_anchor',
  sm_anchor: 'add_anchor',
  save_anchor: 'add_anchor',

  hot_stack: 'get_hot_stack',
  stack: 'get_hot_stack',
  sm_stack: 'get_hot_stack',

  // --- Task tools ---
  new_task: 'create_task',
  add_task: 'create_task',
  sm_task: 'create_task',
  sm_create_task: 'create_task',

  update_task: 'update_task_status',
  set_task_status: 'update_task_status',
  task_update: 'update_task_status',

  list_tasks: 'get_active_tasks',
  tasks: 'get_active_tasks',
  sm_tasks: 'get_active_tasks',
  active_tasks: 'get_active_tasks',

  task_metrics: 'get_task_metrics',
  metrics: 'get_task_metrics',

  // --- Search & Discovery ---
  sm_context_search: 'sm_search',
  search: 'sm_search',
  context_search: 'sm_search',
  sm_find: 'sm_search',
  find: 'sm_search',

  discover: 'sm_discover',
  sm_explore: 'sm_discover',
  explore: 'sm_discover',

  related: 'sm_related_files',
  find_related: 'sm_related_files',

  session_summary: 'sm_session_summary',
  summary: 'sm_session_summary',

  // --- Save/Load context (old MCP server) ---
  sm_save: 'save_context',
  sm_context_save: 'save_context',
  store_context: 'save_context',

  sm_load: 'load_context',
  sm_context_load: 'load_context',
  retrieve_context: 'load_context',

  // --- Linear tools ---
  linear_issues: 'linear_get_tasks',
  linear_list: 'linear_get_tasks',
  get_linear_tasks: 'linear_get_tasks',

  linear_update: 'linear_update_task',
  update_linear: 'linear_update_task',

  linear_comment: 'linear_create_comment',
  comment_on_issue: 'linear_create_comment',

  linear_comments: 'linear_list_comments',

  // --- Trace tools ---
  traces: 'get_traces',
  sm_traces: 'get_traces',
  list_traces: 'get_traces',

  trace_stats: 'get_trace_statistics',
  trace_statistics: 'get_trace_statistics',

  // --- Smart context ---
  smart: 'smart_context',
  sm_smart: 'smart_context',
  intelligent_context: 'smart_context',

  sm_summary: 'get_summary',
  project_summary: 'get_summary',

  // --- Planning tools ---
  plan: 'plan_only',
  generate_plan: 'plan_only',
  sm_plan: 'plan_only',

  codex: 'call_codex',
  run_codex: 'call_codex',

  claude: 'call_claude',
  ask_claude: 'call_claude',

  gate: 'plan_gate',
  plan_and_gate: 'plan_gate',

  approve: 'approve_plan',
  execute_plan: 'approve_plan',

  // --- Pending tools ---
  pending: 'pending_list',
  list_pending: 'pending_list',

  clear_pending: 'pending_clear',

  show_pending: 'pending_show',

  // --- Edit tools ---
  fuzzy_edit: 'sm_edit',
  edit: 'sm_edit',
  sm_fuzzy_edit: 'sm_edit',

  // --- DiffMem tools ---
  user_context: 'diffmem_get_user_context',
  get_user_context: 'diffmem_get_user_context',
  user_memory: 'diffmem_get_user_context',

  store_learning: 'diffmem_store_learning',
  learn: 'diffmem_store_learning',
  remember: 'diffmem_store_learning',

  memory_search: 'diffmem_search',
  search_memory: 'diffmem_search',

  diffmem: 'diffmem_status',
  memory_status: 'diffmem_status',

  // --- Digest tools ---
  digest: 'sm_digest',
  activity_digest: 'sm_digest',
  daily_digest: 'sm_digest',

  // --- Desire paths ---
  desire_paths: 'sm_desire_paths',
  desires: 'sm_desire_paths',
  failed_tools: 'sm_desire_paths',

  // --- Provider tools ---
  delegate: 'delegate_to_model',
  route: 'delegate_to_model',
  send_to_model: 'delegate_to_model',

  batch: 'batch_submit',
  submit_batch: 'batch_submit',

  check_batch: 'batch_check',
  batch_status: 'batch_check',

  // --- Greptile tools ---
  pr_comments: 'greptile_pr_comments',
  review_comments: 'greptile_pr_comments',

  pr_details: 'greptile_pr_details',
  pr_info: 'greptile_pr_details',

  list_prs: 'greptile_list_prs',
  prs: 'greptile_list_prs',

  trigger_review: 'greptile_trigger_review',
  review_pr: 'greptile_trigger_review',

  search_patterns: 'greptile_search_patterns',
  patterns: 'greptile_search_patterns',

  create_pattern: 'greptile_create_pattern',
  add_pattern: 'greptile_create_pattern',

  greptile: 'greptile_status',

  // --- Provenant tools ---
  decision_search: 'provenant_search',
  search_decisions: 'provenant_search',

  log_decision_graph: 'provenant_log',
  decision_log: 'provenant_log',

  decision_status: 'provenant_status',
  graph_status: 'provenant_status',

  contradictions: 'provenant_contradictions',
  conflicts: 'provenant_contradictions',

  resolve: 'provenant_resolve',
  resolve_contradiction: 'provenant_resolve',
};

/**
 * Parameter alias mappings per tool.
 *
 * Key: canonical tool name
 * Value: Record mapping alias param name -> canonical param name
 *
 * Only tools where agents commonly send wrong param names are listed.
 */
const PARAM_ALIASES: Record<string, Record<string, string>> = {
  // Agents often send `query` for search-like tools
  sm_search: {
    search_term: 'query',
    search: 'query',
    text: 'query',
    q: 'query',
    max: 'limit',
    max_results: 'limit',
    count: 'limit',
  },
  sm_discover: {
    search: 'query',
    q: 'query',
    search_query: 'query',
    max: 'maxFiles',
    max_files: 'maxFiles',
    limit: 'maxFiles',
    include: 'includePatterns',
    exclude: 'excludePatterns',
  },
  get_context: {
    search: 'query',
    q: 'query',
    text: 'query',
    max: 'limit',
    max_results: 'limit',
    count: 'limit',
  },
  smart_context: {
    search: 'query',
    q: 'query',
    tokens: 'tokenBudget',
    token_budget: 'tokenBudget',
    max_tokens: 'tokenBudget',
    budget: 'tokenBudget',
    refresh: 'forceRefresh',
    force: 'forceRefresh',
  },
  get_active_tasks: {
    state: 'status',
    max: 'limit',
    max_results: 'limit',
    count: 'limit',
    query: 'search',
    q: 'search',
  },
  linear_get_tasks: {
    status: 'state',
    max: 'limit',
    max_results: 'limit',
    count: 'limit',
    q: 'search',
    query: 'search',
    team: 'team_id',
    assignee: 'assignee_id',
  },
  add_decision: {
    text: 'content',
    decision: 'content',
    value: 'content',
    kind: 'type',
    category: 'type',
  },
  add_anchor: {
    content: 'text',
    value: 'text',
    anchor: 'text',
    kind: 'type',
    category: 'type',
    importance: 'priority',
    weight: 'priority',
  },
  start_frame: {
    title: 'name',
    goal: 'name',
    label: 'name',
    kind: 'type',
    frame_type: 'type',
  },
  create_task: {
    name: 'title',
    goal: 'title',
    label: 'title',
    desc: 'description',
    detail: 'description',
    details: 'description',
  },
  sm_desire_paths: {
    type: 'category',
    kind: 'category',
    max: 'limit',
    max_results: 'limit',
    lookback: 'days',
    period: 'days',
  },
  delegate_to_model: {
    text: 'prompt',
    message: 'prompt',
    input: 'prompt',
    tokens: 'maxTokens',
    max_tokens: 'maxTokens',
    temp: 'temperature',
    task: 'taskType',
    task_type: 'taskType',
  },
  provenant_search: {
    text: 'query',
    search: 'query',
    q: 'query',
    max: 'limit',
    max_results: 'limit',
    from: 'since',
    after: 'since',
    by: 'actor',
    who: 'actor',
  },
  provenant_log: {
    decision: 'content',
    text: 'content',
    value: 'content',
    by: 'actor',
    who: 'actor',
    why: 'reasoning',
    reason: 'reasoning',
    rationale: 'reasoning',
  },
  diffmem_store_learning: {
    insight: 'content',
    text: 'content',
    value: 'content',
    type: 'category',
    kind: 'category',
  },
  diffmem_search: {
    text: 'query',
    search: 'query',
    q: 'query',
    max: 'limit',
    max_results: 'limit',
    time: 'timeRange',
    range: 'timeRange',
    time_range: 'timeRange',
    min_confidence: 'minConfidence',
    threshold: 'minConfidence',
  },
  sm_edit: {
    path: 'file_path',
    file: 'file_path',
    find: 'old_string',
    search: 'old_string',
    replace: 'new_string',
    replacement: 'new_string',
  },
  sm_digest: {
    time: 'period',
    range: 'period',
    timeframe: 'period',
  },
  get_summary: {
    refresh: 'forceRefresh',
    force: 'forceRefresh',
  },
};

/**
 * Resolve a tool name to its canonical form.
 * Returns the canonical name and whether an alias was used.
 */
export function resolveToolAlias(name: string): AliasResolution {
  const alias = TOOL_ALIASES[name];
  if (alias) {
    return { canonicalName: alias, wasAlias: true, originalName: name };
  }
  return { canonicalName: name, wasAlias: false, originalName: name };
}

/**
 * Resolve parameter aliases for a given tool.
 * Remaps aliased param names to canonical names.
 * Original params take precedence over aliases (don't overwrite).
 */
export function resolveParamAliases(
  toolName: string,
  params: Record<string, unknown>
): ParamResolution {
  const aliases = PARAM_ALIASES[toolName];
  if (!aliases) {
    return { resolvedParams: { ...params }, renames: {} };
  }

  const resolved: Record<string, unknown> = {};
  const renames: Record<string, string> = {};

  // First pass: copy all canonical params
  for (const [key, value] of Object.entries(params)) {
    if (!aliases[key]) {
      // Not an alias, keep as-is
      resolved[key] = value;
    }
  }

  // Second pass: apply aliases (only if canonical name not already set)
  for (const [key, value] of Object.entries(params)) {
    const canonicalKey = aliases[key];
    if (canonicalKey && !(canonicalKey in resolved)) {
      resolved[canonicalKey] = value;
      renames[key] = canonicalKey;
    }
  }

  return { resolvedParams: resolved, renames };
}

/**
 * Get all registered aliases for a canonical tool name.
 * Useful for enriching tool descriptions.
 */
export function getAliasesForTool(canonicalName: string): string[] {
  return Object.entries(TOOL_ALIASES)
    .filter(([, target]) => target === canonicalName)
    .map(([alias]) => alias);
}

/**
 * Get all canonical tool names that have aliases.
 */
export function getToolsWithAliases(): string[] {
  return Array.from(new Set(Object.values(TOOL_ALIASES)));
}

/**
 * Get the full alias registry (for debugging/analysis).
 */
export function getAliasRegistry(): Readonly<Record<string, string>> {
  return TOOL_ALIASES;
}

/**
 * Get the full param alias registry (for debugging/analysis).
 */
export function getParamAliasRegistry(): Readonly<
  Record<string, Record<string, string>>
> {
  return PARAM_ALIASES;
}
