/**
 * Client-safe utility functions
 * These can be safely imported in client components
 */

/**
 * Safely parse JSON from a Response object
 * Handles empty responses and non-JSON content
 */
export async function safeJsonParse(response: Response): Promise<any> {
  const contentType = response.headers.get('content-type');
  const text = await response.text();
  
  if (!text) {
    // Empty response
    return { error: `Empty response: ${response.statusText}` };
  }
  
  if (contentType?.includes('application/json')) {
    try {
      return JSON.parse(text);
    } catch (e) {
      return { error: `Invalid JSON response: ${text.substring(0, 100)}` };
    }
  }
  
  // Non-JSON response
  return { error: text || `Unexpected content type: ${contentType}` };
}

