/**
 * Performance monitoring for database queries
 * Helps identify slow queries that are blocking the application
 */

const ENABLE_LOGGING = process.env.NODE_ENV === 'development' || process.env.ENABLE_DB_LOGGING === 'true';
const SLOW_QUERY_THRESHOLD = 100; // Log queries taking more than 100ms

interface QueryLog {
  query: string;
  duration: number;
  timestamp: number;
  params?: any[];
}

const queryLogs: QueryLog[] = [];
const MAX_LOGS = 100;

export function logQuery(query: string, duration: number, params?: any[]) {
  if (!ENABLE_LOGGING) return;
  
  if (duration > SLOW_QUERY_THRESHOLD) {
    const log: QueryLog = {
      query: query.substring(0, 200), // Truncate long queries
      duration,
      timestamp: Date.now(),
      params: params ? params.slice(0, 5) : undefined, // Only log first 5 params
    };
    
    queryLogs.push(log);
    if (queryLogs.length > MAX_LOGS) {
      queryLogs.shift();
    }
    
    console.warn(`[SLOW QUERY] ${duration.toFixed(2)}ms: ${query.substring(0, 100)}`);
    if (params && params.length > 0) {
      console.warn(`  Params: ${JSON.stringify(params.slice(0, 3))}`);
    }
  }
}

export function getSlowQueries(): QueryLog[] {
  return [...queryLogs].sort((a, b) => b.duration - a.duration);
}

export function clearLogs() {
  queryLogs.length = 0;
}

/**
 * Wrap a database operation with performance monitoring
 */
export function monitorQuery<T>(
  query: string,
  operation: () => T,
  params?: any[]
): T {
  const start = Date.now();
  try {
    const result = operation();
    const duration = Date.now() - start;
    logQuery(query, duration, params);
    return result;
  } catch (error) {
    const duration = Date.now() - start;
    logQuery(query, duration, params);
    throw error;
  }
}

/**
 * Wrap an async database operation with performance monitoring
 */
export async function monitorQueryAsync<T>(
  query: string,
  operation: () => Promise<T>,
  params?: any[]
): Promise<T> {
  const start = Date.now();
  try {
    const result = await operation();
    const duration = Date.now() - start;
    logQuery(query, duration, params);
    return result;
  } catch (error) {
    const duration = Date.now() - start;
    logQuery(query, duration, params);
    throw error;
  }
}



