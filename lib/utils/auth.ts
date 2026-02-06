import { createClient } from '@/lib/supabase/server';
import { getLocalUser } from '@/lib/db/local-auth';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

/**
 * Check if user is authenticated
 */
export async function isAuthenticated(): Promise<boolean> {
  if (USE_LOCAL_DB) {
    const user = await getLocalUser();
    return !!user;
  }
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return !!user;
}

/**
 * Get current user
 */
export async function getCurrentUser() {
  if (USE_LOCAL_DB) {
    return await getLocalUser();
  }
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return null;
  return user;
}

/**
 * Check if user is admin
 * Assumes admin role is stored in user metadata
 */
export async function isAdmin(): Promise<boolean> {
  const user = await getCurrentUser();
  if (!user) return false;
  return user.user_metadata?.role === 'admin';
}

/**
 * Get BDR ID from current user's email
 * Optimized: In local mode, user.id is already the bdr_reps.id, so no need for extra query
 */
export async function getBdrIdFromUser(): Promise<string | null> {
  const user = await getCurrentUser();
  if (!user) return null;

  if (USE_LOCAL_DB) {
    // In local mode, user.id is already the bdr_reps.id from getLocalUser()
    return user.id ?? null;
  }

  // Supabase mode: need to lookup by email
  if (!user.email) return null;
  const supabase = await createClient();
  const query = (supabase as any)
    .from('bdr_reps')
    .select('id')
    .eq('email', user.email)
    .single();
  const result = await query;
  const { data } = result as { data: any; error: any };

  return data?.id ?? null;
}

