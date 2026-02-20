// Existing MCP server dispatch pattern — add get_frame_summary handler
import { z } from 'zod';

interface Frame {
  id: string;
  name: string;
  status: 'open' | 'closed';
  events: Array<{ id: string; type: string }>;
}

// Simulated frame store
const frames = new Map<string, Frame>();

// Existing tool dispatch (add your handler here)
async function handleToolCall(name: string, args: unknown) {
  switch (name) {
    case 'start_frame': {
      const input = z.object({ name: z.string().min(1) }).parse(args);
      const id = `frame-${Date.now()}`;
      frames.set(id, { id, name: input.name, status: 'open', events: [] });
      return { frameId: id, status: 'opened' };
    }

    case 'close_frame': {
      const input = z.object({ frameId: z.string() }).parse(args);
      const frame = frames.get(input.frameId);
      if (!frame) throw new Error(`Frame not found: ${input.frameId}`);
      frame.status = 'closed';
      return { frameId: frame.id, status: 'closed' };
    }

    // TODO: Add get_frame_summary handler here

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export { handleToolCall };
