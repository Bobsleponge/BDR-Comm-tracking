import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/utils/api-helpers';

/**
 * Batch API endpoint - allows multiple API calls in a single request
 * Reduces network overhead and improves performance
 */
export async function POST(request: NextRequest) {
  try {
    await requireAuth();
    const body = await request.json();
    const { requests } = body;

    if (!Array.isArray(requests)) {
      return NextResponse.json({ error: 'Requests must be an array' }, { status: 400 });
    }

    // Execute all requests in parallel
    const results = await Promise.allSettled(
      requests.map(async (req: { endpoint: string; method?: string; body?: any }) => {
        // Internal API call - construct full URL
        const url = req.endpoint.startsWith('/') 
          ? `${request.nextUrl.origin}${req.endpoint}`
          : req.endpoint;
        
        const response = await fetch(url, {
          method: req.method || 'GET',
          headers: {
            'Content-Type': 'application/json',
            // Forward cookies for auth
            Cookie: request.headers.get('cookie') || '',
          },
          ...(req.body && { body: JSON.stringify(req.body) }),
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
        return { endpoint: req.endpoint, data };
      })
    );

    const batched: Record<string, any> = {};
    requests.forEach((req: { endpoint: string }, index: number) => {
      const result = results[index];
      if (result.status === 'fulfilled') {
        batched[req.endpoint] = result.value.data;
      } else {
        batched[req.endpoint] = { error: result.reason?.message || 'Request failed' };
      }
    });

    return NextResponse.json(batched);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 401 });
  }
}



