import { NextRequest, NextResponse } from 'next/server';
import { createLocalSession } from '@/lib/db/local-auth';
import { createClient } from '@/lib/supabase/server';

export async function POST(request: NextRequest) {
  try {
    const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

    if (USE_LOCAL_DB) {
      const body = await request.json().catch(() => ({}));
      const { email, password } = body;
      
      if (!email || !password) {
        return NextResponse.json({ error: 'Email and password are required' }, { status: 400 });
      }

      const result = await createLocalSession(email, password);
      
      if (!result) {
        return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
      }

      const response = NextResponse.json({ user: result.user });
      response.cookies.set('local_session', result.sessionId, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 60 * 60 * 24 * 7, // 7 days
        path: '/',
      });
      
      return response;
    }

    const supabase = await createClient();
    const body = await request.json().catch(() => ({}));
    const { email, password } = body;
    
    if (!email || !password) {
      return NextResponse.json({ error: 'Email and password are required' }, { status: 400 });
    }

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    
    return NextResponse.json({ user: data.user });
  } catch (error: any) {
    console.error('Signin error:', error);
    return NextResponse.json(
      { error: error.message || 'An error occurred during signin' },
      { status: 500 }
    );
  }
}

