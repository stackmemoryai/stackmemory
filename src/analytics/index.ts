export * from './types/metrics.js';
export * from './core/analytics-service.js';
export * from './api/analytics-api.js';
export * from './queries/metrics-queries.js';

import { AnalyticsService } from './core/analytics-service.js';
import { AnalyticsAPI } from './api/analytics-api.js';

export default {
  AnalyticsService,
  AnalyticsAPI
};