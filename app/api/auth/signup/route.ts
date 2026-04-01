import { NextRequest, NextResponse } from 'next/server';
import { getLocalDB } from '@/lib/db/local-db';
import { generateUUID } from '@/lib/utils/uuid';
import { createLocalSession } from '@/lib/db/local-auth';
import { createClient } from '@/lib/supabase/server';
import { bdrRepSchema } from '@/lib/commission/validators';

function isSecureRequest(request: NextRequest): boolean {
  const forwardedProto = request.headers.get('x-forwarded-proto');
  if (forwardedProto) {
    return forwardedProto.split(',')[0].trim() === 'https';
  }
  return request.nextUrl.protocol === 'https:';
}

export async function POST(request: NextRequest) {
  const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

  if (USE_LOCAL_DB) {
    try {
      const { name, email, password } = await request.json();

      // Validate input
      if (!name || !email || !password) {
        return NextResponse.json(
          { error: 'Name, email, and password are required' },
          { status: 400 }
        );
      }

      // Validate email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return NextResponse.json(
          { error: 'Invalid email format' },
          { status: 400 }
        );
      }

      // Validate password length (minimum 6 characters)
      if (password.length < 6) {
        return NextResponse.json(
          { error: 'Password must be at least 6 characters long' },
          { status: 400 }
        );
      }

      const db = getLocalDB();

      // Check if email already exists
      const existingRep = db.prepare('SELECT * FROM bdr_reps WHERE email = ?').get(email) as any;
      if (existingRep) {
        return NextResponse.json(
          { error: 'An account with this email already exists' },
          { status: 400 }
        );
      }

      // Validate using schema
      const validated = bdrRepSchema.parse({
        name: name.trim(),
        email: email.trim().toLowerCase(),
        status: 'active',
      });

      // Create new BDR rep
      const repId = generateUUID();
      db.prepare(`
        INSERT INTO bdr_reps (id, name, email, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
      `).run(repId, validated.name, validated.email, validated.status);

      // Automatically log in the new user
      const result = await createLocalSession(validated.email, password);

      if (!result) {
        return NextResponse.json(
          { error: 'Account created but failed to log in. Please try logging in manually.' },
          { status: 500 }
        );
      }

      const response = NextResponse.json({ 
        user: result.user,
        message: 'Account created successfully'
      });
      
      response.cookies.set('local_session', result.sessionId, {
        httpOnly: true,
        secure: isSecureRequest(request),
        sameSite: 'lax',
        maxAge: 60 * 60 * 24 * 7, // 7 days
        path: '/',
      });

      return response;
    } catch (error: any) {
      if (error.name === 'ZodError') {
        return NextResponse.json(
          { error: `Validation error: ${error.errors.map((e: any) => e.message).join(', ')}` },
          { status: 400 }
        );
      }
      return NextResponse.json(
        { error: error.message || 'Failed to create account' },
        { status: 500 }
      );
    }
  }

  // For Supabase mode, use Supabase auth
  const supabase = await createClient() as any;
  const { name, email, password } = await request.json();

  // Create auth user
  const { data: authData, error: authError } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        name,
      },
    },
  });

  if (authError) {
    return NextResponse.json({ error: authError.message }, { status: 400 });
  }

  // Create BDR rep record
  if (authData.user) {
    const validated = bdrRepSchema.parse({
      name,
      email,
      status: 'active',
    });

    const repResult = await (supabase
      .from('bdr_reps')
      .insert({
        id: authData.user.id,
        ...validated,
      }) as any);
    const { error: repError } = repResult as { error: any };

    if (repError) {
      // If BDR rep creation fails, we should ideally rollback the auth user
      // For now, just return an error
      return NextResponse.json(
        { error: 'Account created but failed to set up profile. Please contact support.' },
        { status: 500 }
      );
    }
  }

  return NextResponse.json({ 
    user: authData.user,
    message: 'Account created successfully. Please check your email to verify your account.'
  });
}

