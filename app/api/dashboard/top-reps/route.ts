import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess, requireAuth, requireAdmin } from '@/lib/utils/api-helpers';

export async function GET(request: NextRequest) {
  try {
    await requireAuth();
    await requireAdmin();

    const supabase = await createClient();
    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get('limit') || '10', 10);

    // Get all BDRs with their commission totals
    const repsQuery = (supabase as any)
      .from('bdr_reps')
      .select('id, name, email, status');
    const repsResult = await repsQuery;
    const { data: reps, error: repsError } = repsResult as { data: any[] | null; error: any };

    if (repsError) {
      return apiError(repsError.message, 500);
    }

    // Get commission totals for each rep
    const entriesQuery = (supabase as any)
      .from('commission_entries')
      .select('bdr_id, amount, status');
    const entriesResult = await entriesQuery;
    const { data: entries } = entriesResult as { data: any[] | null };

    // Calculate totals per rep
    const repsArray = reps || [];
    const entriesArray = entries || [];
    const repStats = repsArray.map((rep: any) => {
      const repEntries = entriesArray.filter((e: any) => e.bdr_id === rep.id);
      const earned = repEntries
        .filter((e: any) => e.status === 'paid')
        .reduce((sum: number, e: any) => sum + Number(e.amount), 0);
      const pending = repEntries
        .filter((e: any) => e.status === 'pending')
        .reduce((sum: number, e: any) => sum + Number(e.amount), 0);

      return {
        ...rep,
        commissionEarned: Number(earned.toFixed(2)),
        commissionPending: Number(pending.toFixed(2)),
        totalCommission: Number((earned + pending).toFixed(2)),
      };
    });

    // Sort by total commission and limit
    const topReps = repStats
      .sort((a, b) => b.totalCommission - a.totalCommission)
      .slice(0, limit);

    return apiSuccess(topReps);
  } catch (error: any) {
    return apiError(error.message, error.message.includes('Forbidden') ? 403 : 401);
  }
}




