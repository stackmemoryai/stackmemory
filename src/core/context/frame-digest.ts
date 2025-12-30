/**
 * Frame Digest Generation
 * Handles creation of frame summaries and digests
 */

import { Frame, Event, Anchor, DigestResult } from './frame-types.js';
import { FrameDatabase } from './frame-database.js';
import { logger } from '../monitoring/logger.js';

export class FrameDigestGenerator {
  constructor(private frameDb: FrameDatabase) {}

  /**
   * Generate digest for a frame
   */
  generateDigest(frameId: string): DigestResult {
    try {
      const frame = this.frameDb.getFrame(frameId);
      if (!frame) {
        throw new Error(`Frame not found: ${frameId}`);
      }

      const events = this.frameDb.getFrameEvents(frameId);
      const anchors = this.frameDb.getFrameAnchors(frameId);

      // Generate text summary
      const text = this.generateTextDigest(frame, events, anchors);
      
      // Generate structured data
      const structured = this.generateStructuredDigest(frame, events, anchors);

      return { text, structured };
    } catch (error) {
      logger.error('Failed to generate frame digest', { frameId, error });
      
      return {
        text: `Error generating digest for frame ${frameId}`,
        structured: { error: (error as Error).message },
      };
    }
  }

  /**
   * Generate text summary of frame
   */
  private generateTextDigest(frame: Frame, events: Event[], anchors: Anchor[]): string {
    const lines: string[] = [];

    // Frame header
    lines.push(`Frame: ${frame.name} (${frame.type})`);
    lines.push(`Duration: ${this.formatDuration(frame.created_at, frame.closed_at)}`);
    lines.push('');

    // Goals and constraints
    if (frame.inputs.goals) {
      lines.push(`Goals: ${frame.inputs.goals}`);
    }

    if (frame.inputs.constraints && frame.inputs.constraints.length > 0) {
      lines.push(`Constraints: ${frame.inputs.constraints.join(', ')}`);
    }

    // Key anchors
    const importantAnchors = anchors
      .filter(a => a.priority >= 7)
      .sort((a, b) => b.priority - a.priority);

    if (importantAnchors.length > 0) {
      lines.push('');
      lines.push('Key Decisions & Facts:');
      importantAnchors.forEach(anchor => {
        lines.push(`- ${anchor.type}: ${anchor.text}`);
      });
    }

    // Activity summary
    const eventSummary = this.summarizeEvents(events);
    if (eventSummary.length > 0) {
      lines.push('');
      lines.push('Activity Summary:');
      eventSummary.forEach(summary => {
        lines.push(`- ${summary}`);
      });
    }

    // Outputs
    if (frame.outputs && Object.keys(frame.outputs).length > 0) {
      lines.push('');
      lines.push('Outputs:');
      Object.entries(frame.outputs).forEach(([key, value]) => {
        lines.push(`- ${key}: ${this.formatValue(value)}`);
      });
    }

    return lines.join('\n');
  }

  /**
   * Generate structured digest data
   */
  private generateStructuredDigest(frame: Frame, events: Event[], anchors: Anchor[]): Record<string, any> {
    const eventsByType = this.groupEventsByType(events);
    const anchorsByType = this.groupAnchorsByType(anchors);

    return {
      frameId: frame.frame_id,
      frameName: frame.name,
      frameType: frame.type,
      duration: {
        startTime: frame.created_at,
        endTime: frame.closed_at,
        durationMs: frame.closed_at ? (frame.closed_at - frame.created_at) * 1000 : null,
      },
      activity: {
        totalEvents: events.length,
        eventsByType,
        eventTimeline: events.slice(-10).map(e => ({
          type: e.event_type,
          timestamp: e.ts,
          summary: this.summarizeEvent(e),
        })),
      },
      knowledge: {
        totalAnchors: anchors.length,
        anchorsByType,
        keyDecisions: anchors
          .filter(a => a.type === 'DECISION' && a.priority >= 7)
          .map(a => a.text),
        constraints: anchors
          .filter(a => a.type === 'CONSTRAINT')
          .map(a => a.text),
        risks: anchors
          .filter(a => a.type === 'RISK')
          .map(a => a.text),
      },
      outcomes: {
        outputs: frame.outputs,
        success: frame.state === 'closed' && !this.hasErrorEvents(events),
        artifacts: this.extractArtifacts(events),
      },
      metadata: {
        projectId: frame.project_id,
        runId: frame.run_id,
        parentFrameId: frame.parent_frame_id,
        depth: frame.depth,
      },
    };
  }

  /**
   * Summarize events into readable format
   */
  private summarizeEvents(events: Event[]): string[] {
    const summaries: string[] = [];
    const eventsByType = this.groupEventsByType(events);

    // Tool calls summary
    if (eventsByType.tool_call && eventsByType.tool_call.length > 0) {
      const toolCounts = this.countTools(eventsByType.tool_call);
      const toolSummary = Object.entries(toolCounts)
        .map(([tool, count]) => `${tool} (${count})`)
        .join(', ');
      summaries.push(`Tool calls: ${toolSummary}`);
    }

    // Decisions summary
    if (eventsByType.decision && eventsByType.decision.length > 0) {
      summaries.push(`Made ${eventsByType.decision.length} decisions`);
    }

    // Observations summary
    if (eventsByType.observation && eventsByType.observation.length > 0) {
      summaries.push(`Recorded ${eventsByType.observation.length} observations`);
    }

    // Error summary
    const errorEvents = events.filter(e => 
      e.payload.error || e.payload.status === 'error'
    );
    if (errorEvents.length > 0) {
      summaries.push(`Encountered ${errorEvents.length} errors`);
    }

    return summaries;
  }

  /**
   * Group events by type
   */
  private groupEventsByType(events: Event[]): Record<string, Event[]> {
    const groups: Record<string, Event[]> = {};
    
    for (const event of events) {
      if (!groups[event.event_type]) {
        groups[event.event_type] = [];
      }
      groups[event.event_type].push(event);
    }
    
    return groups;
  }

  /**
   * Group anchors by type
   */
  private groupAnchorsByType(anchors: Anchor[]): Record<string, number> {
    const groups: Record<string, number> = {};
    
    for (const anchor of anchors) {
      groups[anchor.type] = (groups[anchor.type] || 0) + 1;
    }
    
    return groups;
  }

  /**
   * Count tool usage
   */
  private countTools(toolEvents: Event[]): Record<string, number> {
    const counts: Record<string, number> = {};
    
    for (const event of toolEvents) {
      const toolName = event.payload.tool_name || 'unknown';
      counts[toolName] = (counts[toolName] || 0) + 1;
    }
    
    return counts;
  }

  /**
   * Check if events contain errors
   */
  private hasErrorEvents(events: Event[]): boolean {
    return events.some(e => 
      e.payload.error || 
      e.payload.status === 'error'
    );
  }

  /**
   * Extract artifacts from events
   */
  private extractArtifacts(events: Event[]): string[] {
    const artifacts: string[] = [];
    
    for (const event of events) {
      if (event.event_type === 'artifact' && event.payload.path) {
        artifacts.push(event.payload.path);
      }
    }
    
    return [...new Set(artifacts)];
  }

  /**
   * Summarize a single event
   */
  private summarizeEvent(event: Event): string {
    switch (event.event_type) {
      case 'tool_call':
        return `${event.payload.tool_name || 'tool'}`;
      case 'decision':
        return `${event.payload.type}: ${event.payload.content?.substring(0, 50)}...`;
      case 'observation':
        return `${event.payload.content?.substring(0, 50)}...`;
      case 'artifact':
        return `Created ${event.payload.path}`;
      default:
        return event.event_type;
    }
  }

  /**
   * Format duration
   */
  private formatDuration(startTime: number, endTime?: number): string {
    if (!endTime) {
      return 'ongoing';
    }
    
    const durationMs = (endTime - startTime) * 1000;
    
    if (durationMs < 1000) {
      return `${durationMs.toFixed(0)}ms`;
    } else if (durationMs < 60000) {
      return `${(durationMs / 1000).toFixed(1)}s`;
    } else {
      return `${(durationMs / 60000).toFixed(1)}m`;
    }
  }

  /**
   * Format value for display
   */
  private formatValue(value: any): string {
    if (typeof value === 'string') {
      return value.length > 100 ? `${value.substring(0, 100)}...` : value;
    } else if (typeof value === 'object') {
      return JSON.stringify(value).substring(0, 100) + '...';
    } else {
      return String(value);
    }
  }
}