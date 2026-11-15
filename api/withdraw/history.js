const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return res.status(500).json({ ok: false, error: 'Withdrawal service is not configured' });
  const supabase = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  const authorization = req.headers.authorization || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (!token) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  const { data: authData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !authData?.user) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  const { data: withdrawals, error } = await supabase.from('withdrawal_requests')
    .select('id, amount, fee_amount, net_amount, status, recipient_name, recipient_mobile, operator, created_at, admin_note')
    .eq('user_id', authData.user.id)
    .order('created_at', { ascending: false })
    .limit(15);
  if (error) {
    console.error('[withdraw/history] request failed:', error);
    return res.status(500).json({ ok: false, error: 'Could not load withdrawal history' });
  }
  return res.status(200).json({ ok: true, withdrawals: withdrawals || [] });
};
