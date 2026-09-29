// api/withdraw/manage.js — CNI admin withdrawal pipeline
// actions: send (to pcmedia) | resend | approve | reject | test (webhook test)
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

async function adminCheck(supabase, req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  const { data: p } = await supabase.from('users').select('is_admin').eq('id', data.user.id).single();
  return p?.is_admin ? data.user : null;
}

// atomic single-winner refund from pending|sent
async function settleReject(supabase, requestId, adminNote, refundDescription) {
  const { data: flipped } = await supabase.from('withdrawal_requests')
    .update({ status: 'rejected', admin_note: adminNote }).eq('id', requestId)
    .in('status', ['pending', 'sent']).select();
  if (!flipped || !flipped.length) return { refunded: false };
  const request = flipped[0];
  const { data: w } = await supabase.from('wallets').select('*').eq('user_id', request.user_id).single();
  if (!w) return { refunded: false };
  const nb = Number(w.balance) + Number(request.amount);
  await supabase.from('wallets').update({ balance: nb, updated_at: new Date().toISOString() }).eq('user_id', request.user_id);
  await supabase.from('wallet_transactions').insert({ user_id: request.user_id, type: 'withdrawal_refund', amount: Number(request.amount), description: refundDescription || 'Withdrawal rejected — refund', balance_after: nb });
  return { refunded: true, amount: Number(request.amount) };
}

async function sendToPcmedia(supabase, request, settings) {
  const url = settings?.pcmedia_bridge_url;
  if (!url) return { ok: false, error: 'pcmedia bridge URL not set in Settings' };
  const { data: user } = await supabase.from('users').select('email, full_name').eq('id', request.user_id).single();
  const payload = {
    id: request.id, request_id: request.id, withdrawal_id: request.id,
    user_email: user?.email, user_name: user?.full_name,
    amount: Number(request.amount), net_amount: Number(request.net_amount), fee: Number(request.fee_amount),
    recipient_name: request.recipient_name, recipient_mobile: request.recipient_mobile,
    country_code: request.country_code, operator: request.operator,
    scheduled_for: request.scheduled_for, created_at: request.created_at
  };
  const bodyStr = JSON.stringify(payload);
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'CNI-Webhook/1.0' };
  if (settings?.pcmedia_bridge_secret) {
    headers['X-GFF-Signature'] = crypto.createHmac('sha256', settings.pcmedia_bridge_secret).update(bodyStr).digest('hex');
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, { method: 'POST', headers, body: bodyStr, signal: ctrl.signal });
    if (r.status >= 200 && r.status < 300) {
      await supabase.from('withdrawal_requests').update({ status: 'sent', pcmedia_sent_at: new Date().toISOString() }).eq('id', request.id);
      return { ok: true, status: r.status };
    }
    return { ok: false, error: `pcmedia returned HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'pcmedia timed out (15s)' : 'Network error: ' + e.message };
  } finally { clearTimeout(timer); }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const admin = await adminCheck(supabase, req);
  if (!admin) return res.status(403).json({ error: 'Admin access required' });

  try {
    const { action, request_id, admin_note, url } = req.body || {};

    // ---- WEBHOOK TEST (no request needed) ----
    if (action === 'test') {
      const target = url || (await supabase.from('platform_settings').select('pcmedia_bridge_url').eq('id', 1).single()).data?.pcmedia_bridge_url;
      if (!target) return res.status(400).json({ error: 'No URL configured' });
      const dummy = { test: true, request_id: 'test-' + Date.now(), amount: 5000, net_amount: 4600, fee: 400, recipient_name: 'Test', recipient_mobile: '237600000000', country_code: 'CM', operator: 'mtn' };
      const r = await fetch(target, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dummy) });
      return res.status(200).json({ ok: true, status: r.status });
    }

    const { data: request } = await supabase.from('withdrawal_requests').select('*').eq('id', request_id).single();
    if (!request) return res.status(400).json({ error: 'Request not found' });
    const { data: settings } = await supabase.from('platform_settings').select('*').eq('id', 1).single();

    // ---- SEND / RESEND TO PCMEDIA ----
    if (action === 'send' || action === 'resend') {
      if (action === 'send' && request.status !== 'pending') return res.status(400).json({ error: `Already ${request.status}` });
      if (action === 'resend' && request.status !== 'sent') return res.status(400).json({ error: `Can only resend from SENT (currently ${request.status})` });
      const result = await sendToPcmedia(supabase, request, settings);
      return res.status(result.ok ? 200 : 502).json(result.ok ? { ok: true, message: `Sent to pcmedia (HTTP ${result.status})` } : { error: result.error });
    }

    // ---- APPROVE (manual confirm after pcmedia paid) ----
    if (action === 'approve') {
      if (request.status !== 'pending' && request.status !== 'sent') return res.status(400).json({ error: `Already ${request.status}` });
      await supabase.from('withdrawal_requests').update({ status: 'approved', admin_note: (admin_note ? admin_note + ' • ' : '') + 'Approved by admin' }).eq('id', request_id);
      return res.status(200).json({ ok: true, message: 'Approved' });
    }

    // ---- REJECT + REFUND ----
    if (action === 'reject') {
      if (request.status !== 'pending' && request.status !== 'sent') return res.status(400).json({ error: `Already ${request.status}` });
      const settle = await settleReject(supabase, request_id, admin_note || 'Rejected by admin', 'Withdrawal rejected by admin — refund');
      return res.status(200).json({ ok: true, message: settle.refunded ? 'Rejected & refunded' : 'Already settled — no refund' });
    }

    return res.status(400).json({ error: 'Invalid action' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
