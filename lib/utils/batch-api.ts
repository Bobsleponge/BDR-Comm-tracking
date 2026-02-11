/**
 * Batch API requests to reduce network overhead
 * Combines multiple API calls into a single request
 */

interface BatchedRequest {
  endpoint: string;
  method?: string;
  body?: any;
}

export async function batchRequests(requests: BatchedRequest[]): Promise<Record<string, any>> {
  // For now, execute in parallel (better than sequential)
  // In the future, could implement a true batching endpoint
  const results = await Promise.allSettled(
    requests.map(async (req) => {
      const response = await fetch(req.endpoint, {
        method: req.method || 'GET',
        credentials: 'include',
        ...(req.body && {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(req.body),
        }),
      });
      
      // Check if response has content before parsing JSON
      const contentType = response.headers.get('content-type');
      const text = await response.text();
      
      let data: any;
      if (text && contentType?.includes('application/json')) {
        try {
          data = JSON.parse(text);
        } catch (e) {
          throw new Error(`Invalid JSON response: ${text.substring(0, 100)}`);
        }
      } else if (text) {
        // Non-JSON response
        data = { error: text || `Failed: ${response.statusText}` };
      } else {
        // Empty response
        data = { error: `Empty response: ${response.statusText}` };
      }
      
      if (!response.ok || data.error) {
        throw new Error(data.error || `Failed: ${response.statusText}`);
      }
      return data;
    })
  );

  const batched: Record<string, any> = {};
  requests.forEach((req, index) => {
    const result = results[index];
    if (result.status === 'fulfilled') {
      batched[req.endpoint] = result.value;
    } else {
      batched[req.endpoint] = { error: result.reason?.message || 'Request failed' };
    }
  });

  return batched;
}



