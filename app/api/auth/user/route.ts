import { NextResponse } from 'next/server';
import { getLocalUser } from '@/lib/db/local-auth';
import { createClient } from '@/lib/supabase/server';

export async function GET() {
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/f0f85447-8287-450d-8621-69d25602cd44',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'app/api/auth/user/route.ts:5',message:'GET /api/auth/user called',data:{},timestamp:Date.now(),runId:'run1',hypothesisId:'D'})}).catch(()=>{});
  // #endregion
  try {
    const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/f0f85447-8287-450d-8621-69d25602cd44',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'app/api/auth/user/route.ts:9',message:'USE_LOCAL_DB determined',data:{USE_LOCAL_DB,hasSupabaseUrl:!!process.env.NEXT_PUBLIC_SUPABASE_URL},timestamp:Date.now(),runId:'run1',hypothesisId:'D'})}).catch(()=>{});
    // #endregion

    if (USE_LOCAL_DB) {
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/f0f85447-8287-450d-8621-69d25602cd44',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'app/api/auth/user/route.ts:12',message:'Calling getLocalUser',data:{},timestamp:Date.now(),runId:'run1',hypothesisId:'D'})}).catch(()=>{});
      // #endregion
      const user = await getLocalUser();
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/f0f85447-8287-450d-8621-69d25602cd44',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'app/api/auth/user/route.ts:14',message:'getLocalUser completed',data:{hasUser:!!user,userId:user?.id,email:user?.email},timestamp:Date.now(),runId:'run1',hypothesisId:'D'})}).catch(()=>{});
      // #endregion
      if (user) {
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/f0f85447-8287-450d-8621-69d25602cd44',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'app/api/auth/user/route.ts:16',message:'Returning user response',data:{},timestamp:Date.now(),runId:'run1',hypothesisId:'D'})}).catch(()=>{});
        // #endregion
        return NextResponse.json({ 
          user,
          role: user.user_metadata?.role || 'bdr'
        });
      }
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/f0f85447-8287-450d-8621-69d25602cd44',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'app/api/auth/user/route.ts:22',message:'No user, returning null',data:{},timestamp:Date.now(),runId:'run1',hypothesisId:'D'})}).catch(()=>{});
      // #endregion
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
  } catch (error: any) {
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/f0f85447-8287-450d-8621-69d25602cd44',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'app/api/auth/user/route.ts:35',message:'Error in GET /api/auth/user',data:{error:error?.message,stack:error?.stack?.substring(0,200)},timestamp:Date.now(),runId:'run1',hypothesisId:'D'})}).catch(()=>{});
    // #endregion
    return NextResponse.json({ error: error?.message || 'Internal server error' }, { status: 500 });
  }
}

