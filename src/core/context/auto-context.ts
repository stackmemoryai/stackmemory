/**
 * Auto-context management
 * Automatically creates and manages context frames
 */

import { FrameManager } from './frame-manager.js';
import { logger } from '../monitoring/logger.js';

export class AutoContext {
  private frameManager: FrameManager;
  
  constructor(frameManager: FrameManager) {
    this.frameManager = frameManager;
  }
  
  /**
   * Initialize a session context
   */
  initializeSession(command?: string): void {
    try {
      // Create a root session frame
      const sessionFrame = this.frameManager.createFrame({
        type: 'task',
        name: 'Session',
        inputs: {
          command,
          timestamp: new Date().toISOString(),
          cwd: process.cwd(),
        }
      });
      
      logger.info('Session context initialized', { 
        frameId: sessionFrame,
        depth: this.frameManager.getStackDepth() 
      });
    } catch (error) {
      logger.error('Failed to initialize session context', error as Error);
    }
  }
  
  /**
   * Create a command context
   */
  createCommandContext(command: string, args?: any): string | null {
    try {
      const frameId = this.frameManager.createFrame({
        type: 'tool_scope',
        name: command,
        inputs: args
      });
      
      logger.info('Command context created', { 
        frameId,
        command,
        depth: this.frameManager.getStackDepth() 
      });
      
      return frameId;
    } catch (error) {
      logger.error('Failed to create command context', error as Error);
      return null;
    }
  }
  
  /**
   * Auto-save important context
   */
  autoSaveContext(data: any, importance: number = 5): void {
    try {
      const currentFrame = this.frameManager.getCurrentFrameId();
      if (currentFrame) {
        this.frameManager.addEvent('observation', {
          type: 'context_save',
          data,
          importance,
          timestamp: new Date().toISOString()
        }, currentFrame);
      }
    } catch (error) {
      logger.error('Failed to auto-save context', error as Error);
    }
  }
}