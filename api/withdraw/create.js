// api/withdraw/create.js — CNI user withdrawal request (8% fee, min from settings, unlimited)
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    const { data } = await supabase.auth.getUser(token);
    if (!data?.user) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    const uid = data.user.id;

    const { data: prof } = await supabase.from('users').select('is_banned').eq('id', uid).single();
    if (prof?.is_banned) return res.status(403).json({ ok: false, error: 'Account suspended — contact support' });

    const { amount, recipient_name, recipient_mobile, country_code, operator } = req.body || {};
    const amt = Number(amount);
    const { data: s } = await supabase.from('platform_settings').select('*').eq('id', 1).single();
    const FEE_PCT = Number(s?.withdrawal_fee_percent ?? 8);
    const MIN = Number(s?.min_withdrawal ?? 1500);

    if (!Number.isFinite(amt) || amt < MIN) return res.status(400).json({ ok: false, error: `Minimum withdrawal is ${MIN.toLocaleString()} FCFA` });
    if ((recipient_name || '').trim().length < 3) return res.status(400).json({ ok: false, error: 'Recipient name required' });
    if (!/^237\d{9}$/.test(String(recipient_mobile || ''))) return res.status(400).json({ ok: false, error: 'Valid 237... MoMo number required' });

    const { data: wallet } = await supabase.from('wallets').select('*').eq('user_id', uid).single();
    if (!wallet || Number(wallet.balance) < amt) return res.status(400).json({ ok: false, error: 'Insufficient balance' });

    const fee = Math.round(amt * FEE_PCT / 100);
    const net = amt - fee;

    const { data: newReq, error: e1 } = await supabase.from('withdrawal_requests').insert({
      user_id: uid, bank_card_id: null, amount: amt, fee_percent: FEE_PCT, fee_amount: fee, net_amount: net,
      status: 'pending', recipient_name: recipient_name.trim(), recipient_mobile: String(recipient_mobile).replace(/\s/g, ''),
      country_code: country_code || 'CM', operator: operator || 'mtn', scheduled_for: new Date().toISOString()
    }).select().single();
    if (e1) throw e1;

    const nb = Number(wallet.balance) - amt;
    await supabase.from('wallets').update({ balance: nb, updated_at: new Date().toISOString() }).eq('user_id', uid);
    await supabase.from('wallet_transactions').insert({
      user_id: uid, type: 'withdrawal', amount: -amt,
      description: `Withdrawal request (${net.toLocaleString()} net after ${FEE_PCT}% fee)`, balance_after: nb
    });

    return res.status(200).json({ ok: true, request_id: newReq.id, net, fee });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
