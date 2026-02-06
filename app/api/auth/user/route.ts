import { NextResponse } from 'next/server';
import { getLocalUser } from '@/lib/db/local-auth';
import { createClient } from '@/lib/supabase/server';

export async function GET() {
  const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

  if (USE_LOCAL_DB) {
    const user = await getLocalUser();
    if (user) {
      return NextResponse.json({ 
        user,
        role: user.user_metadata?.role || 'bdr'
      });
    }
    return NextResponse.json({ user: null, role: null });
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (user) {
    return NextResponse.json({ 
      user,
      role: user.user_metadata?.role || 'bdr'
    });
  }
  return NextResponse.json({ user: null, role: null });
}

