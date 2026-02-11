import { NextResponse } from 'next/server';

/**
 * Create API error response
 */
export function apiError(message: string, status: number = 400) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Create API success response with optional caching
 */
export function apiSuccess<T>(data: T, status: number = 200, options?: { 
  cache?: 'no-store' | 'force-cache' | number; // number = seconds to cache
  revalidate?: number;
}) {
  const headers = new Headers();
  
  if (options?.cache) {
    if (options.cache === 'no-store') {
      headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    } else if (options.cache === 'force-cache') {
      headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (typeof options.cache === 'number') {
      // Aggressive caching with stale-while-revalidate for better performance
      headers.set('Cache-Control', `public, s-maxage=${options.cache}, stale-while-revalidate=${options.cache * 3}, max-age=${options.cache}`);
    }
  } else {
    // Default: longer cache for better performance
    headers.set('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=90, max-age=30');
  }
  
  return NextResponse.json(data, { status, headers });
}

/**
 * Require authentication middleware
 */
export async function requireAuth() {
  const { isAuthenticated } = await import('./auth');
  const authenticated = await isAuthenticated();
  if (!authenticated) {
    throw new Error('Unauthorized');
  }
}

/**
 * Require admin role middleware
 */
export async function requireAdmin() {
  const { isAdmin } = await import('./auth');
  if (!(await isAdmin())) {
    throw new Error('Forbidden: Admin access required');
  }
}

/**
 * Check if user can access BDR data
 * Returns true if admin or if bdrId matches user's BDR ID
 */
export async function canAccessBdr(bdrId: string): Promise<boolean> {
  const { isAdmin, getBdrIdFromUser } = await import('./auth');
  if (await isAdmin()) return true;
  const userBdrId = await getBdrIdFromUser();
  return userBdrId === bdrId;
}




