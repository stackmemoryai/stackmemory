/**
 * Linear API Trace Wrapper
 * Wraps Linear API client with comprehensive tracing for debugging
 */

import { trace, Trace } from './debug-trace.js';
import { logger } from '../monitoring/logger.js';

/**
 * Decorator to trace Linear API GraphQL calls
 */
export function TraceLinearAPI(
  target: any,
  propertyKey: string,
  descriptor: PropertyDescriptor
) {
  const originalMethod = descriptor.value;
  const isAsync = originalMethod.constructor.name === 'AsyncFunction';

  if (isAsync) {
    descriptor.value = async function (...args: any[]) {
      const className = target.constructor.name;
      const methodName = `${className}.${propertyKey}`;
      
      // Extract meaningful context from arguments
      const context = extractAPIContext(propertyKey, args);
      
      return trace.traceAsync('api', methodName, context, async () => {
        const startTime = Date.now();
        
        try {
          // Log API call start
          logger.debug(`Linear API Call: ${methodName}`, context);
          
          const result = await originalMethod.apply(this, args);
          
          const duration = Date.now() - startTime;
          
          // Log successful completion with timing
          logger.info(`Linear API Success: ${methodName}`, {
            duration,
            resultType: Array.isArray(result) ? `array[${result.length}]` : typeof result,
            hasData: result != null,
          });
          
          // Warn about slow API calls
          if (duration > 1000) {
            logger.warn(`Slow Linear API call: ${methodName} took ${duration}ms`, {
              ...context,
              duration,
            });
          }
          
          return result;
        } catch (error: any) {
          const duration = Date.now() - startTime;
          
          // Enhanced error logging for API failures
          logger.error(`Linear API Failed: ${methodName}`, error, {
            ...context,
            duration,
            errorCode: error.code,
            statusCode: error.statusCode,
            graphQLErrors: error.errors,
          });
          
          // Add debugging hints based on error type
          if (error.message?.includes('rate limit')) {
            logger.warn('Rate limit hit - consider implementing backoff', {
              method: methodName,
              suggestion: 'Implement exponential backoff or request queuing',
            });
          } else if (error.message?.includes('network')) {
            logger.warn('Network error - check connectivity', {
              method: methodName,
              suggestion: 'Verify API endpoint and network connectivity',
            });
          } else if (error.message?.includes('unauthorized')) {
            logger.warn('Authorization error - check API key', {
              method: methodName,
              suggestion: 'Verify LINEAR_API_KEY is set and valid',
            });
          }
          
          throw error;
        }
      });
    };
  } else {
    descriptor.value = function (...args: any[]) {
      const className = target.constructor.name;
      const methodName = `${className}.${propertyKey}`;
      const context = extractAPIContext(propertyKey, args);
      
      return trace.traceSync('api', methodName, context, () => {
        return originalMethod.apply(this, args);
      });
    };
  }

  return descriptor;
}

/**
 * Extract meaningful context from API method arguments
 */
function extractAPIContext(methodName: string, args: any[]): Record<string, any> {
  const context: Record<string, any> = {};
  
  // Handle different Linear API methods
  if (methodName === 'createIssue' && args[0]) {
    context.title = args[0].title;
    context.teamId = args[0].teamId;
    context.priority = args[0].priority;
  } else if (methodName === 'updateIssue' && args[0]) {
    context.issueId = args[0];
    context.updates = Object.keys(args[1] || {});
  } else if (methodName === 'getIssue') {
    context.issueId = args[0];
  } else if (methodName === 'getIssues' && args[0]) {
    context.filter = args[0];
  } else if (methodName === 'graphql') {
    // For raw GraphQL queries
    const query = args[0];
    if (query) {
      // Extract operation name from query
      const match = query.match(/(?:query|mutation)\s+(\w+)/);
      context.operation = match ? match[1] : 'unknown';
      context.queryLength = query.length;
      context.variables = args[1] ? Object.keys(args[1]) : [];
    }
  }
  
  return context;
}

/**
 * Wrap fetch with tracing for HTTP-level debugging
 */
export function createTracedFetch(baseFetch = fetch): typeof fetch {
  return async function tracedFetch(
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method || 'GET';
    
    // Mask sensitive headers
    const headers = init?.headers ? { ...init.headers } : {};
    if (headers.Authorization) {
      headers.Authorization = headers.Authorization.substring(0, 20) + '...[MASKED]';
    }
    
    const context = {
      method,
      url: url.length > 100 ? url.substring(0, 100) + '...' : url,
      headers: Object.keys(headers),
      bodySize: init?.body ? JSON.stringify(init.body).length : 0,
    };
    
    return trace.api(method, url, context, async () => {
      const startTime = Date.now();
      
      try {
        const response = await baseFetch(input, init);
        const duration = Date.now() - startTime;
        
        // Log response details
        logger.debug(`HTTP ${method} ${response.status}`, {
          url: url.substring(0, 100),
          status: response.status,
          duration,
          headers: {
            'content-type': response.headers.get('content-type'),
            'x-ratelimit-remaining': response.headers.get('x-ratelimit-remaining'),
            'x-ratelimit-reset': response.headers.get('x-ratelimit-reset'),
          },
        });
        
        // Warn about rate limiting
        const remaining = response.headers.get('x-ratelimit-remaining');
        if (remaining && parseInt(remaining) < 10) {
          logger.warn(`Low rate limit remaining: ${remaining}`, {
            url: url.substring(0, 100),
            resetAt: response.headers.get('x-ratelimit-reset'),
          });
        }
        
        // Warn about slow responses
        if (duration > 2000) {
          logger.warn(`Slow HTTP response: ${duration}ms`, {
            method,
            url: url.substring(0, 100),
            status: response.status,
          });
        }
        
        return response;
      } catch (error: any) {
        const duration = Date.now() - startTime;
        
        logger.error(`HTTP ${method} failed`, error, {
          url: url.substring(0, 100),
          duration,
          errorType: error.constructor.name,
          errno: error.errno,
          code: error.code,
        });
        
        throw error;
      }
    });
  };
}

/**
 * Create a traced GraphQL client wrapper
 */
export function wrapGraphQLClient<T>(client: T): T {
  const prototype = Object.getPrototypeOf(client);
  const propertyNames = Object.getOwnPropertyNames(prototype);
  
  for (const propertyName of propertyNames) {
    if (propertyName === 'constructor') continue;
    
    const descriptor = Object.getOwnPropertyDescriptor(prototype, propertyName);
    if (!descriptor || typeof descriptor.value !== 'function') continue;
    
    // Apply tracing to all methods
    TraceLinearAPI(prototype, propertyName, descriptor);
    Object.defineProperty(prototype, propertyName, descriptor);
  }
  
  return client;
}