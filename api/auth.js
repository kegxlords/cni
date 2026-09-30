// api/auth.js — registration (uses UPSERT to handle both trigger-fired and manual cases)
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
    // 1. Find referrer if code provided
    let referrerId = null;
    const code = (referral_code || '').trim().toUpperCase();
    if (code) {
      const { data: ref } = await supabase.from('users').select('id').eq('referral_code', code).single();
      if (!ref) return res.status(400).json({ ok: false, error: 'Invalid referral code' });
      referrerId = ref.id;
    }

    // 2. Create Auth User (Service Role bypasses RLS & Triggers initially)
    const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
      email: email.toLowerCase().trim(),
      password,
      email_confirm: true,
      user_metadata: { full_name: full_name.trim(), phone: phone || null, referral_code: code }
    });
    if (authErr) return res.status(400).json({ ok: false, error: authErr.message });

    const uid = authData.user.id;

    // 3. Generate unique Referral Code for NEW USER
    let newRefCode = '';
    for (let i = 0; i < 5; i++) {
      const candidate = 'CNI' + Math.random().toString(36).slice(2, 7).toUpperCase();
      const { data: check } = await supabase.from('users').select('id').eq('referral_code', candidate).single();
      if (!check) { newRefCode = candidate; break; }
    }
    if (!newRefCode) newRefCode = 'CNI' + Date.now().toString(36).slice(-5).toUpperCase();

    // 4. 🛡️ SAFE PROFILE CREATION (Uses UPSERT to avoid duplicates)
    // If trigger ran first, this UPDATES the existing row instead of crashing.
    // If trigger failed/didn't run, this INSERTS a fresh row.
    const { error: profErr } = await supabase.from('users').upsert({
      id: uid,
      email: email.toLowerCase().trim(),
      full_name: full_name.trim(),
      phone: phone || null,
      referral_code: newRefCode,
      referred_by: referrerId,
      vip_level: 0,
      is_admin: false,
      is_banned: false
    }, { onConflict: 'id' }); // Only conflict on Primary Key (ID)

    if (profErr) throw new Error('Profile creation failed: ' + profErr.message);

    // 5. 🛡️ SAFE WALLET CREATION (Also uses UPSERT)
    const { error: walErr } = await supabase.from('wallets').upsert({
      user_id: uid,
      balance: 0,
      total_deposit: 0,
      total_profit: 0,
      total_referral_earnings: 0
    }, { onConflict: 'user_id' });

    if (walErr) throw new Error('Wallet creation failed: ' + walErr.message);

    return res.status(200).json({ ok: true, id: uid, referral_code: newRefCode });

  } catch (e) {
    console.error('[CNI] Register exception:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};
