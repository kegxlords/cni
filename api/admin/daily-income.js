// api/admin/daily-income.js — nightly 32.5% yield cron (15-day plans)
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // accept Vercel cron secret OR an admin bearer token
  const auth = (req.headers.authorization || '').replace('Bearer ', '');
  let allowed = !!process.env.CRON_SECRET && auth === process.env.CRON_SECRET;
  if (!allowed && auth) {
    const { data } = await supabase.auth.getUser(auth);
    if (data?.user) {
      const { data: p } = await supabase.from('users').select('is_admin').eq('id', data.user.id).single();
      allowed = !!p?.is_admin;
    }
  }
  if (!allowed) return res.status(403).json({ error: 'Forbidden' });

  try {
    const { data, error } = await supabase.rpc('run_daily_income');
    if (error) return res.status(500).json({ ok: false, error: error.message });
    console.log('[cni-cron] daily income', JSON.stringify(data));
    return res.status(200).json(data || { ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
