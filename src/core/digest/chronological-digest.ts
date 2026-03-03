/**
 * Chronological Digest Generator
 * Produces compact markdown summaries of activity for today/yesterday/week periods.
 */

import type Database from 'better-sqlite3';

export type DigestPeriod = 'today' | 'yesterday' | 'week';

interface FrameRow {
  frame_id: string;
  name: string;
  type: string;
  state: string;
  created_at: number;
  closed_at: number | null;
  inputs: string;
  outputs: string;
}

interface AnchorRow {
  anchor_id: string;
  frame_id: string;
  type: string;
  text: string;
  priority: number;
  created_at: number;
}

interface EventRow {
  event_id: string;
  frame_id: string;
  event_type: string;
  payload: string;
  ts: number;
}

function getTimeRange(period: DigestPeriod): {
  start: number;
  end: number;
  label: string;
} {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  switch (period) {
    case 'today': {
      return {
        start: Math.floor(todayStart.getTime() / 1000),
        end: Math.floor(now.getTime() / 1000),
        label: `Today — ${todayStart.toISOString().slice(0, 10)}`,
      };
    }
    case 'yesterday': {
      const yesterdayStart = new Date(todayStart);
      yesterdayStart.setDate(yesterdayStart.getDate() - 1);
      return {
        start: Math.floor(yesterdayStart.getTime() / 1000),
        end: Math.floor(todayStart.getTime() / 1000),
        label: `Yesterday — ${yesterdayStart.toISOString().slice(0, 10)}`,
      };
    }
    case 'week': {
      const weekStart = new Date(todayStart);
      weekStart.setDate(weekStart.getDate() - 7);
      return {
        start: Math.floor(weekStart.getTime() / 1000),
        end: Math.floor(now.getTime() / 1000),
        label: `Week — ${weekStart.toISOString().slice(0, 10)} to ${todayStart.toISOString().slice(0, 10)}`,
      };
    }
  }
}

function formatDate(epoch: number): string {
  return new Date(epoch * 1000).toISOString().slice(0, 10);
}

export function generateChronologicalDigest(
  db: Database.Database,
  period: DigestPeriod,
  projectId: string
): string {
  const { start, end, label } = getTimeRange(period);

  // Query frames in the time window — try exact project_id, fallback to 'default', then all
  let frames = db
    .prepare(
      `SELECT frame_id, name, type, state, created_at, closed_at, inputs, outputs
       FROM frames
       WHERE project_id = ? AND created_at >= ? AND created_at < ?
       ORDER BY created_at ASC`
    )
    .all(projectId, start, end) as FrameRow[];

  if (frames.length === 0 && projectId !== 'default') {
    frames = db
      .prepare(
        `SELECT frame_id, name, type, state, created_at, closed_at, inputs, outputs
         FROM frames
         WHERE project_id = 'default' AND created_at >= ? AND created_at < ?
         ORDER BY created_at ASC`
      )
      .all(start, end) as FrameRow[];
  }

  if (frames.length === 0) {
    return `# ${label}\n\nNo activity recorded.\n`;
  }

  // Query anchors for these frames
  const frameIds = frames.map((f) => f.frame_id);
  const placeholders = frameIds.map(() => '?').join(',');
  const anchors = db
    .prepare(
      `SELECT anchor_id, frame_id, type, text, priority, created_at
       FROM anchors
       WHERE frame_id IN (${placeholders})
       ORDER BY priority DESC, created_at ASC`
    )
    .all(...frameIds) as AnchorRow[];

  // Query events for file counts (tool_call events with file_path)
  const events = db
    .prepare(
      `SELECT event_id, frame_id, event_type, payload, ts
       FROM events
       WHERE frame_id IN (${placeholders}) AND event_type IN ('tool_call', 'decision')
       ORDER BY ts ASC`
    )
    .all(...frameIds) as EventRow[];

  // Group anchors and events by frame
  const anchorsByFrame = new Map<string, AnchorRow[]>();
  for (const a of anchors) {
    const list = anchorsByFrame.get(a.frame_id) || [];
    list.push(a);
    anchorsByFrame.set(a.frame_id, list);
  }

  const eventsByFrame = new Map<string, EventRow[]>();
  for (const e of events) {
    const list = eventsByFrame.get(e.frame_id) || [];
    list.push(e);
    eventsByFrame.set(e.frame_id, list);
  }

  // Group frames by date for week view
  const framesByDate = new Map<string, FrameRow[]>();
  for (const f of frames) {
    const date = formatDate(f.created_at);
    const list = framesByDate.get(date) || [];
    list.push(f);
    framesByDate.set(date, list);
  }

  const lines: string[] = [`# ${label}\n`];

  const renderFrame = (f: FrameRow) => {
    lines.push(`## ${f.name} (${f.type}, ${f.state})`);

    const frameAnchors = anchorsByFrame.get(f.frame_id) || [];
    const frameEvents = eventsByFrame.get(f.frame_id) || [];

    // Key decisions and constraints
    for (const a of frameAnchors.slice(0, 8)) {
      lines.push(`- ${a.type}: ${a.text}`);
    }

    // Count files from tool_call events
    const files = new Set<string>();
    for (const e of frameEvents) {
      try {
        const payload = JSON.parse(e.payload);
        if (payload.arguments?.file_path)
          files.add(payload.arguments.file_path);
        if (payload.arguments?.path) files.add(payload.arguments.path);
      } catch {
        // ignore parse errors
      }
    }

    if (files.size > 0) {
      lines.push(`- ${files.size} files touched`);
    }

    lines.push('');
  };

  if (period === 'week') {
    // Week: group by date
    for (const [date, dateFrames] of framesByDate) {
      lines.push(`### ${date}\n`);
      for (const f of dateFrames) {
        renderFrame(f);
      }
    }
  } else {
    // Today/yesterday: flat list
    for (const f of frames) {
      renderFrame(f);
    }
  }

  // Summary stats
  const completed = frames.filter((f) => f.state === 'completed').length;
  const active = frames.filter((f) => f.state === 'active').length;
  lines.push('---');
  lines.push(
    `*${frames.length} frames total: ${completed} completed, ${active} active*`
  );
  lines.push(`*Generated: ${new Date().toISOString()}*\n`);

  return lines.join('\n');
}
