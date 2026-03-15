import { createHash } from 'node:crypto';
import type { SourceAdapter, RawRecord, SignalWeight } from './adapter.js';

export interface SlackAdapterConfig {
  botToken: string; // xoxb-...
  baseUrl?: string;
  excludeChannels?: string[]; // channel names to skip
}

const SLACK_API = 'https://slack.com/api';

// Slack-specific confidence signals — conversational, lower baseline than Linear
const SLACK_SIGNALS: SignalWeight[] = [
  {
    name: 'trigger_phrase',
    weight: 0.3,
    detect: (r) => {
      const phrases = [
        'we decided',
        'going with',
        "won't do",
        'not doing',
        "won't fix",
        'deprioritizing',
        'cutting',
        'closing',
        'agreed to',
        'moving forward with',
        'final call',
        'decision:',
        'resolved:',
        'shipping',
        'locking in',
        "let's go with",
        'locked in',
      ];
      const lower = r.content.toLowerCase();
      return phrases.some((p) => lower.includes(p));
    },
  },
  {
    name: 'trigger_phrase_multiple',
    weight: 0.3,
    detect: (r) => {
      const phrases = [
        'we decided',
        'going with',
        "won't do",
        'not doing',
        'deprioritizing',
        'cutting',
        'agreed to',
        'moving forward with',
        'final call',
        'decision:',
        'resolved:',
        'shipping',
        'locking in',
      ];
      const lower = r.content.toLowerCase();
      let count = 0;
      for (const p of phrases) {
        if (lower.includes(p)) count++;
      }
      return count >= 2;
    },
  },
  {
    name: 'imperative_verb',
    weight: 0.15,
    detect: (r) => {
      const patterns =
        /^(we will|we are|we're going to|let's|ship|build|remove|add|create|close|cut)\b/im;
      return patterns.test(r.content);
    },
  },
  {
    name: 'explicit_actor',
    weight: 0.1,
    detect: (r) => r.actor != null && r.actor.length > 0,
  },
  {
    name: 'is_thread_reply',
    weight: 0.1,
    detect: (r) => {
      const meta = r.metadata as { replyCount?: number } | undefined;
      return (meta?.replyCount ?? 0) > 2;
    },
  },
  {
    name: 'question_framing',
    weight: -0.2,
    detect: (r) => {
      const lower = r.content.toLowerCase();
      return (
        lower.includes('?') ||
        lower.startsWith('should we') ||
        lower.startsWith('what if') ||
        lower.startsWith('do we')
      );
    },
  },
  {
    name: 'hedge_language',
    weight: -0.15,
    detect: (r) => {
      const hedges = [
        'maybe',
        'probably',
        'might',
        'could be',
        'not sure',
        'i think',
        'possibly',
      ];
      const lower = r.content.toLowerCase();
      return hedges.some((h) => lower.includes(h));
    },
  },
  {
    name: 'short_message',
    weight: -0.25,
    detect: (r) => r.content.length < 20,
  },
];

interface SlackChannel {
  id: string;
  name: string;
  is_private: boolean;
  is_archived: boolean;
}

interface SlackMessage {
  type: string;
  ts: string;
  user?: string;
  text: string;
  thread_ts?: string;
  reply_count?: number;
  replies?: Array<{ user: string; ts: string }>;
}

interface SlackUser {
  id: string;
  real_name: string;
  name: string;
}

export class SlackAdapter implements SourceAdapter {
  system = 'slack';
  signalModel = SLACK_SIGNALS;

  private readonly token: string;
  private readonly baseUrl: string;
  private readonly excludeChannels: Set<string>;
  private userCache = new Map<string, string>();

  constructor(config: SlackAdapterConfig) {
    this.token = config.botToken;
    this.baseUrl = config.baseUrl ?? SLACK_API;
    this.excludeChannels = new Set(config.excludeChannels ?? []);
  }

  static fromEnv(): SlackAdapter | undefined {
    const token = process.env['SLACK_BOT_TOKEN'];
    if (!token) return undefined;
    const exclude = process.env['SLACK_EXCLUDE_CHANNELS']
      ?.split(',')
      .map((s) => s.trim());
    return new SlackAdapter({ botToken: token, excludeChannels: exclude });
  }

  hashRecord(record: RawRecord): string {
    return createHash('sha256').update(record.raw_payload).digest('hex');
  }

  async fetch(since: Date): Promise<RawRecord[]> {
    const records: RawRecord[] = [];
    const channels = await this.listPublicChannels();
    const sinceTs = (since.getTime() / 1000).toString();

    for (const channel of channels) {
      if (this.excludeChannels.has(channel.name)) continue;
      if (channel.is_archived) continue;

      const messages = await this.fetchChannelHistory(channel.id, sinceTs);

      for (const msg of messages) {
        if (!msg.text || msg.text.length === 0) continue;

        const actor = msg.user ? await this.resolveUser(msg.user) : undefined;

        // Parent message
        records.push({
          external_id: `${channel.id}-${msg.ts}`,
          content: msg.text,
          raw_payload: JSON.stringify({
            ...msg,
            channel_id: channel.id,
            channel_name: channel.name,
          }),
          actor,
          created_at: parseSlackTs(msg.ts),
          metadata: {
            channelId: channel.id,
            channelName: channel.name,
            threadTs: msg.thread_ts,
            replyCount: msg.reply_count ?? 0,
            isThread: !!msg.thread_ts && msg.thread_ts !== msg.ts,
          },
        });

        // Fetch thread replies if this is a thread parent with replies
        if (
          msg.reply_count &&
          msg.reply_count > 0 &&
          msg.thread_ts === msg.ts
        ) {
          const replies = await this.fetchThreadReplies(
            channel.id,
            msg.ts,
            sinceTs
          );
          for (const reply of replies) {
            if (reply.ts === msg.ts) continue; // skip parent
            if (!reply.text) continue;

            const replyActor = reply.user
              ? await this.resolveUser(reply.user)
              : undefined;
            records.push({
              external_id: `${channel.id}-${reply.ts}`,
              content: reply.text,
              raw_payload: JSON.stringify({
                ...reply,
                channel_id: channel.id,
                channel_name: channel.name,
                parent_ts: msg.ts,
              }),
              actor: replyActor,
              created_at: parseSlackTs(reply.ts),
              metadata: {
                channelId: channel.id,
                channelName: channel.name,
                threadTs: msg.ts,
                replyCount: msg.reply_count,
                isThread: true,
              },
            });
          }
        }
      }
    }

    return records;
  }

  // --- Slack API calls ---

  private async listPublicChannels(): Promise<SlackChannel[]> {
    const channels: SlackChannel[] = [];
    let cursor: string | undefined;

    do {
      const params = new URLSearchParams({
        types: 'public_channel',
        exclude_archived: 'false', // include archived — may contain decisions
        limit: '200',
      });
      if (cursor) params.set('cursor', cursor);

      const data = await this.api<{
        channels: SlackChannel[];
        response_metadata?: { next_cursor?: string };
      }>('conversations.list', params);

      channels.push(...data.channels);
      cursor = data.response_metadata?.next_cursor || undefined;
    } while (cursor);

    return channels.filter((c) => !c.is_private);
  }

  private async fetchChannelHistory(
    channelId: string,
    oldestTs: string
  ): Promise<SlackMessage[]> {
    const messages: SlackMessage[] = [];
    let cursor: string | undefined;

    do {
      const params = new URLSearchParams({
        channel: channelId,
        oldest: oldestTs,
        limit: '200',
      });
      if (cursor) params.set('cursor', cursor);

      const data = await this.api<{
        messages: SlackMessage[];
        has_more?: boolean;
        response_metadata?: { next_cursor?: string };
      }>('conversations.history', params);

      messages.push(...data.messages);
      cursor = data.response_metadata?.next_cursor || undefined;
    } while (cursor);

    return messages;
  }

  private async fetchThreadReplies(
    channelId: string,
    threadTs: string,
    oldestTs: string
  ): Promise<SlackMessage[]> {
    const params = new URLSearchParams({
      channel: channelId,
      ts: threadTs,
      oldest: oldestTs,
      limit: '200',
    });

    const data = await this.api<{
      messages: SlackMessage[];
    }>('conversations.replies', params);

    return data.messages;
  }

  private async resolveUser(userId: string): Promise<string> {
    const cached = this.userCache.get(userId);
    if (cached) return cached;

    try {
      const data = await this.api<{ user: SlackUser }>(
        'users.info',
        new URLSearchParams({ user: userId })
      );
      const name = data.user.real_name || data.user.name;
      this.userCache.set(userId, name);
      return name;
    } catch {
      return userId;
    }
  }

  private async api<T>(method: string, params: URLSearchParams): Promise<T> {
    const url = `${this.baseUrl}/${method}?${params.toString()}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.token}` },
    });

    if (!response.ok) {
      throw new Error(
        `Slack API error ${response.status}: ${await response.text()}`
      );
    }

    const json = (await response.json()) as { ok: boolean; error?: string } & T;
    if (!json.ok) {
      throw new Error(`Slack API error: ${json.error}`);
    }

    return json as T;
  }
}

function parseSlackTs(ts: string): number {
  return Math.floor(parseFloat(ts) * 1000);
}
