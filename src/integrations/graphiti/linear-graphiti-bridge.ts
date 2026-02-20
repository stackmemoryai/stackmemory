/**
 * Linear-Graphiti Bridge
 * Converts Linear webhook events into Graphiti episodes, entities, and relations
 */

import { logger } from '../../core/monitoring/logger.js';
import { GraphitiClient } from './client.js';
import type { Episode, EntityNode, RelationEdge } from './types.js';
import type { GraphitiIntegrationConfig } from './config.js';
import type { LinearWebhookPayload } from '../linear/webhook.js';

export class LinearGraphitiBridge {
  private client: GraphitiClient;

  constructor(config: Partial<GraphitiIntegrationConfig> = {}) {
    this.client = new GraphitiClient(config);
  }

  async processWebhook(payload: LinearWebhookPayload): Promise<void> {
    const { action, data } = payload;
    const now = Date.now();

    try {
      // 1. Upsert episode
      const episode: Episode = {
        type: `linear_issue_${action}`,
        content: {
          identifier: data.identifier,
          title: data.title,
          action,
          state: data.state?.name,
          priority: data.priority,
          assignee: data.assignee?.name,
        },
        timestamp: now,
        source: 'linear',
      };
      await this.client.upsertEpisode(episode);

      // Skip entity/relation upserts on remove
      if (action === 'remove') return;

      // 2. Upsert entities
      const entities: EntityNode[] = [
        {
          type: 'Issue',
          name: data.identifier,
          summary: data.title,
          properties: {
            linearId: data.id,
            state: data.state?.name,
            priority: data.priority,
          },
        },
      ];

      if (data.assignee) {
        entities.push({
          type: 'Person',
          name: data.assignee.name,
          properties: {
            linearId: data.assignee.id,
            email: data.assignee.email,
          },
        });
      }

      if (data.team) {
        entities.push({
          type: 'Team',
          name: data.team.name,
          properties: { linearId: data.team.id, key: data.team.key },
        });
      }

      if (data.labels?.length) {
        for (const label of data.labels) {
          entities.push({
            type: 'Label',
            name: label.name,
            properties: { linearId: label.id, color: label.color },
          });
        }
      }

      const entityResult = await this.client.upsertEntities(entities);

      // 3. Upsert relations
      const issueId = entityResult.ids[0];
      const relations: RelationEdge[] = [];
      let idx = 1; // entity index after Issue

      if (data.assignee) {
        relations.push({
          fromId: issueId,
          toId: entityResult.ids[idx],
          type: 'ASSIGNED_TO',
          validFrom: now,
        });
        idx++;
      }

      if (data.team) {
        relations.push({
          fromId: issueId,
          toId: entityResult.ids[idx],
          type: 'BELONGS_TO',
          validFrom: now,
        });
        idx++;
      }

      if (data.labels?.length) {
        for (let i = 0; i < data.labels.length; i++) {
          relations.push({
            fromId: issueId,
            toId: entityResult.ids[idx + i],
            type: 'HAS_LABEL',
            validFrom: now,
          });
        }
      }

      if (relations.length > 0) {
        await this.client.upsertRelations(relations);
      }
    } catch (error) {
      logger.debug('Linear-Graphiti bridge error', {
        action,
        identifier: data.identifier,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
