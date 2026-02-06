import { createBrowserClient } from '@supabase/ssr'

// Detect local mode - check if Supabase URL is missing (local mode)
// This should match the server-side logic in middleware.ts and API routes
function isLocalMode() {
  // Check explicit flag first (for client-side, use NEXT_PUBLIC_ prefix)
  if (process.env.NEXT_PUBLIC_USE_LOCAL_DB === 'true') return true;
  if (typeof window === 'undefined') return false;
  // If Supabase URL is not set, default to local mode (matches server logic)
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  return !supabaseUrl || supabaseUrl === 'http://localhost:54321' || supabaseUrl === '';
}

export function createClient() {
  if (isLocalMode()) {
    // Return a mock client for browser - actual auth handled server-side
    return {
      auth: {
        getUser: async () => {
          try {
            const res = await fetch('/api/auth/user', {
              credentials: 'include',
            });
            if (!res.ok) {
              return { data: { user: null }, error: null };
            }
            const data = await res.json();
            return { data: { user: data.user }, error: null };
          } catch (error) {
            // Silently fail in local mode - user might not be logged in yet
            return { data: { user: null }, error: null };
          }
        },
        signInWithPassword: async ({ email, password }: { email: string; password: string }) => {
          const res = await fetch('/api/auth/signin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ email, password }),
          });
          const data = await res.json();
          if (data.error) {
            return { data: { user: null, session: null }, error: { message: data.error } };
          }
          return { data: { user: data.user, session: { access_token: 'local' } }, error: null };
        },
        signOut: async () => {
          await fetch('/api/auth/signout', { 
            method: 'POST',
            credentials: 'include',
          });
          return { error: null };
        },
        onAuthStateChange: (callback: any) => {
          // Simple implementation
          return { data: { subscription: null }, unsubscribe: () => {} };
        },
      },
      from: () => ({
        select: () => ({ then: async () => ({ data: [], error: null }) }),
      }),
    } as any;
  }

  // Fallback to local mode if Supabase URL is not available
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  
  if (!supabaseUrl || !supabaseKey) {
    // Fallback to local mode
    return {
      auth: {
        getUser: async () => {
          try {
            const res = await fetch('/api/auth/user', { credentials: 'include' });
            if (!res.ok) {
              return { data: { user: null }, error: null };
            }
            const data = await res.json();
            return { data: { user: data.user }, error: null };
          } catch (error) {
            // Silently fail in local mode - user might not be logged in yet
            return { data: { user: null }, error: null };
          }
        },
        signInWithPassword: async ({ email, password }: { email: string; password: string }) => {
          const res = await fetch('/api/auth/signin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ email, password }),
          });
          const data = await res.json();
          if (data.error) {
            return { data: { user: null, session: null }, error: { message: data.error } };
          }
          return { data: { user: data.user, session: { access_token: 'local' } }, error: null };
        },
        signOut: async () => {
          await fetch('/api/auth/signout', { method: 'POST', credentials: 'include' });
          return { error: null };
        },
        onAuthStateChange: () => ({ data: { subscription: null }, unsubscribe: () => {} }),
      },
      from: () => ({ select: () => ({ then: async () => ({ data: [], error: null }) }) }),
    } as any;
  }

  return createBrowserClient(supabaseUrl, supabaseKey)
}

