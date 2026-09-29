// api/auth.js — registration (trigger creates profile + wallet)
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, full_name, email, phone, password, referral_code } = req.body || {};
  if (action !== 'register') return res.status(400).json({ ok: false, error: 'Unknown action' });

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '')) return res.status(400).json({ ok: false, error: 'Valid email required' });
  if ((password || '').length < 6) return res.status(400).json({ ok: false, error: 'Password must be at least 6 characters' });
  if ((full_name || '').trim().length < 3) return res.status(400).json({ ok: false, error: 'Full name required' });

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  try {
    let referrer = null;
    const code = (referral_code || '').trim().toUpperCase();
    if (code) {
      const { data: ref } = await supabase.from('users').select('id').eq('referral_code', code).single();
      if (!ref) return res.status(400).json({ ok: false, error: 'Invalid referral code' });
      referrer = code;
    }

    const { data, error } = await supabase.auth.admin.createUser({
      email: email.toLowerCase().trim(),
      password,
      email_confirm: true,
      user_metadata: { full_name: full_name.trim(), phone: phone || null, referral_code: referrer }
    });
    if (error) return res.status(400).json({ ok: false, error: error.message });
    return res.status(200).json({ ok: true, id: data.user.id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
