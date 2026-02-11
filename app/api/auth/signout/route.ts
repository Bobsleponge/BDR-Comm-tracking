import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { deleteLocalSession } from '@/lib/db/local-auth';
import { createClient } from '@/lib/supabase/server';

export async function POST() {
  const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

  if (USE_LOCAL_DB) {
    const cookieStore = await cookies();
    const sessionId = cookieStore.get('local_session')?.value;
    if (sessionId) {
      await deleteLocalSession(sessionId);
    }
    const response = NextResponse.json({ success: true });
    response.cookies.delete('local_session');
    return response;
  }

  const supabase = await createClient();
  await supabase.auth.signOut();
  return NextResponse.json({ success: true });
}







