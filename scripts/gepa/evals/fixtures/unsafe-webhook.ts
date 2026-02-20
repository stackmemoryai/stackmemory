// Webhook handler with validation vulnerabilities
interface WebhookPayload {
  action: string;
  type: string;
  data: {
    id: string;
    title?: string;
    description?: string;
    [key: string]: unknown;
  };
}

// VULNERABLE: No prototype pollution protection, no length limits,
// no action validation. Fix this function.
function validateWebhookPayload(payload: unknown): WebhookPayload | null {
  if (!payload || typeof payload !== 'object') return null;

  const p = payload as Record<string, unknown>;

  if (!p.action || typeof p.action !== 'string') return null;
  if (!p.type || typeof p.type !== 'string') return null;
  if (!p.data || typeof p.data !== 'object') return null;

  const data = p.data as Record<string, unknown>;
  if (!data.id || typeof data.id !== 'string') return null;

  // No sanitization — title and description can be any length
  // No action validation — accepts any string
  // No prototype pollution check — __proto__ passes through

  return p as unknown as WebhookPayload;
}

export { validateWebhookPayload, WebhookPayload };
