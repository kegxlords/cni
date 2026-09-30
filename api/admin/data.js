// api/admin/data.js — authenticated, read-only data for the CNI admin UI.
const { createClient } = require('@supabase/supabase-js');

const ALLOWED_WITHDRAWAL_STATUSES = new Set(['pending', 'sent', 'approved', 'rejected']);

function failOnError(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result;
}

async function requireAdmin(supabase, req) {
  const authorization = req.headers.authorization || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (!token) return null;

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;

  const profileResult = failOnError(
    await supabase.from('users').select('is_admin').eq('id', data.user.id).maybeSingle(),
    'Could not verify admin role'
  );
  return profileResult.data?.is_admin ? data.user : null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    console.error('[admin/data] Supabase server credentials are not configured');
    return res.status(500).json({ error: 'Admin data service is not configured' });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  try {
    const admin = await requireAdmin(supabase, req);
    if (!admin) return res.status(403).json({ error: 'Admin access required' });

    const action = String(req.query.action || '');

    if (action === 'overview') {
      const midnightUtc = new Date();
      midnightUtc.setUTCHours(0, 0, 0, 0);
      const last24Hours = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const [users, banned, pending, sent, approvedToday, deposits24h, recent] = await Promise.all([
        supabase.from('users').select('id', { count: 'exact', head: true }),
        supabase.from('users').select('id', { count: 'exact', head: true }).eq('is_banned', true),
        supabase.from('withdrawal_requests').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
        supabase.from('withdrawal_requests').select('id', { count: 'exact', head: true }).eq('status', 'sent'),
        supabase.from('withdrawal_requests').select('id', { count: 'exact', head: true }).eq('status', 'approved').gte('created_at', midnightUtc.toISOString()),
        supabase.from('payment_transactions').select('amount').eq('kind', 'deposit').eq('status', 'paid').gte('created_at', last24Hours),
        supabase.from('withdrawal_requests').select('*, users(full_name)').order('created_at', { ascending: false }).limit(8)
      ]);
      [users, banned, pending, sent, approvedToday, deposits24h, recent].forEach((r, i) => failOnError(r, `Overview query ${i + 1} failed`));
      return res.status(200).json({
        users: users.count || 0,
        banned: banned.count || 0,
        pending: pending.count || 0,
        sent: sent.count || 0,
        approvedToday: approvedToday.count || 0,
        deposits24h: deposits24h.data || [],
        recent: recent.data || []
      });
    }

    if (action === 'users') {
      const [users, wallets] = await Promise.all([
        supabase.from('users').select('*').order('created_at', { ascending: false }),
        supabase.from('wallets').select('*')
      ]);
      failOnError(users, 'Could not load users');
      failOnError(wallets, 'Could not load wallets');
      return res.status(200).json({ users: users.data || [], wallets: wallets.data || [] });
    }

    if (action === 'deposits') {
      const last24Hours = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const [pending, pendingCount, paid24h, settled] = await Promise.all([
        supabase.from('payment_transactions').select('*, users(full_name, email)').eq('kind', 'deposit').eq('status', 'pending').order('created_at', { ascending: false }).limit(30),
        supabase.from('payment_transactions').select('id', { count: 'exact', head: true }).eq('kind', 'deposit').eq('status', 'pending'),
        supabase.from('payment_transactions').select('amount').eq('kind', 'deposit').eq('status', 'paid').gte('created_at', last24Hours),
        supabase.from('payment_transactions').select('*, users(full_name)').eq('kind', 'deposit').neq('status', 'pending').order('created_at', { ascending: false }).limit(10)
      ]);
      [pending, pendingCount, paid24h, settled].forEach((r, i) => failOnError(r, `Deposit query ${i + 1} failed`));
      return res.status(200).json({
        pending: pending.data || [],
        pendingCount: pendingCount.count || 0,
        paid24h: paid24h.data || [],
        settled: settled.data || []
      });
    }

    if (action === 'withdrawals') {
      const status = String(req.query.status || 'pending');
      if (!ALLOWED_WITHDRAWAL_STATUSES.has(status)) return res.status(400).json({ error: 'Invalid withdrawal status' });
      const [pending, sent, approved, withdrawals] = await Promise.all([
        supabase.from('withdrawal_requests').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
        supabase.from('withdrawal_requests').select('id', { count: 'exact', head: true }).eq('status', 'sent'),
        supabase.from('withdrawal_requests').select('id', { count: 'exact', head: true }).eq('status', 'approved'),
        supabase.from('withdrawal_requests').select('*, users(full_name, email)').eq('status', status).order('created_at', { ascending: false }).limit(50)
      ]);
      [pending, sent, approved, withdrawals].forEach((r, i) => failOnError(r, `Withdrawal query ${i + 1} failed`));
      return res.status(200).json({
        counts: { pending: pending.count || 0, sent: sent.count || 0, approved: approved.count || 0 },
        withdrawals: withdrawals.data || []
      });
    }

    if (action === 'settings') {
      const result = failOnError(
        await supabase.from('platform_settings').select('*').eq('id', 1).maybeSingle(),
        'Could not load platform settings'
      );
      if (!result.data) return res.status(404).json({ error: 'Platform settings row not found' });
      return res.status(200).json({ settings: result.data });
    }

    return res.status(400).json({ error: 'Unknown admin data action' });
  } catch (error) {
    console.error('[admin/data] request failed:', error);
    return res.status(500).json({ error: 'Could not load admin data' });
  }
};
