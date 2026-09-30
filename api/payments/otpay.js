// api/payments/otpay.js — CNI deposits via OTPay + admin deposit actions
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const MODE = process.env.OTPAY_MODE === 'live' ? 'live' : 'test';
const CFG = MODE === 'live'
  ? { payUrl: process.env.OTPAY_LIVE_PAY_URL, merchantId: process.env.OTPAY_LIVE_MERCHANT_ID, appSecret: process.env.OTPAY_LIVE_APP_SECRET }
  : { payUrl: process.env.OTPAY_TEST_PAY_URL, merchantId: process.env.OTPAY_TEST_MERCHANT_ID, appSecret: process.env.OTPAY_TEST_APP_SECRET };

const md5 = s => crypto.createHash('md5').update(s, 'utf8').digest('hex').toLowerCase();
const fmtAmt = n => Number(n).toFixed(2);
const signCreate = (id, amt) => md5(`merchantId=${CFG.merchantId}&merchantOrderId=${id}&amount=${fmtAmt(amt)}&appSecret=${CFG.appSecret}`);

const REDACT = ['appSecret', 'sign', 'mobile', 'email', 'accountNumber'];
function redact(o, d = 0) {
  if (d > 8) return '[redacted]';
  if (o === null || o === undefined || typeof o !== 'object') return o;
  if (Array.isArray(o)) return o.map(x => redact(x, d + 1));
  const out = {};
  for (const [k, v] of Object.entries(o)) out[k] = REDACT.includes(k) ? '[REDACTED]' : redact(v, d + 1);
  return out;
}
const log = (t, m, d) => console.log(`[${new Date().toISOString()}] [${t}] ${m}${d ? ' ' + JSON.stringify(redact(d)) : ''}`);

const COUNTRY = {
  CM: { currency: 'XAF', re: /^237\d{9}$/ }, CI: { currency: 'XOF', re: /^225\d{8}$/ },
  SN: { currency: 'XOF', re: /^221\d{9}$/ }, NG: { currency: 'NGN', re: /^234\d{10}$/ }, GH: { currency: 'GHS', re: /^233\d{9}$/ }
};
const PREFIX = { CM: '237', CI: '225', SN: '221', NG: '234', GH: '233' };
const national = (cc, m) => { const s = String(m || '').replace(/\s/g, ''); const p = PREFIX[cc]; return p && s.startsWith(p) ? s.slice(p.length) : s; };

async function get(path, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(CFG.payUrl + path, { signal: ctrl.signal });
    return { status: res.status, data: await res.json().catch(() => null) };
  } catch (e) {
    if (e.name === 'AbortError') { const err = new Error('OTPAY_TIMEOUT_15S'); err.timeout = true; throw err; }
    throw e;
  } finally { clearTimeout(timer); }
}
async function post(path, body, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(CFG.payUrl + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
    return { status: res.status, data: await res.json().catch(() => null) };
  } catch (e) {
    if (e.name === 'AbortError') { const err = new Error('OTPAY_TIMEOUT_15S'); err.timeout = true; throw err; }
    throw e;
  } finally { clearTimeout(timer); }
}

// ---------- CREDIT DEPOSIT (wallet auto-create + 30% referral) ----------
async function creditDeposit({ supabase, user_id, amount, provider_ref, description }) {
  let { data: wallet, error } = await supabase.from('wallets').select('*').eq('user_id', user_id).maybeSingle();
  if (error || !wallet) {
    const { data: nw, error: ie } = await supabase.from('wallets').insert({ user_id, balance: 0, total_deposit: 0, total_profit: 0, total_referral_earnings: 0, updated_at: new Date().toISOString() }).select().single();
    if (ie) throw new Error('Failed to create wallet: ' + ie.message);
    wallet = nw;
  }
  const amt = Number(amount);
  const nb = Number(wallet.balance) + amt;
  await supabase.from('wallets').update({ balance: nb, total_deposit: Number(wallet.total_deposit || 0) + amt, updated_at: new Date().toISOString() }).eq('user_id', user_id);
  await supabase.from('wallet_transactions').insert({ user_id, type: 'deposit', amount: amt, description, balance_after: nb });

  const { data: st } = await supabase.from('platform_settings').select('referral_bonus_percent').eq('id', 1).single();
  const pct = Number(st?.referral_bonus_percent ?? 30);
  const { data: user } = await supabase.from('users').select('referred_by').eq('id', user_id).single();
  if (user?.referred_by) {
    const comm = Math.round(amt * pct / 100);
    const { data: rw } = await supabase.from('wallets').select('*').eq('user_id', user.referred_by).single();
    if (rw) {
      const rb = Number(rw.balance) + comm;
      await supabase.from('wallets').update({ balance: rb, total_referral_earnings: Number(rw.total_referral_earnings || 0) + comm, updated_at: new Date().toISOString() }).eq('user_id', user.referred_by);
      await supabase.from('wallet_transactions').insert({ user_id: user.referred_by, type: 'referral_bonus', amount: comm, description: pct + '% commission on downline deposit [' + user_id + ']', balance_after: rb });
    }
  }
  return { newBalance: nb };
}

async function adminCheck(supabase, req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  const { data: p } = await supabase.from('users').select('is_admin').eq('id', data.user.id).single();
  return p?.is_admin ? data.user : null;
}

// ---------- DEPOSIT CREATE ----------
async function depositCreate(supabase, uid, b) {
  const amt = Number(b.amount);
  if (!Number.isFinite(amt) || amt < 500) return { status: 400, body: { error: 'Minimum deposit is 500' } };
  const cc = b.country_code || 'CM';
  const c = COUNTRY[cc];
  if (!c) return { status: 400, body: { error: 'Unsupported country' } };
  if (!c.re.test(String(b.mobile))) return { status: 400, body: { error: `Mobile must match ${cc} format (e.g. 2376XXXXXXXX)` } };

  const { data: prof } = await supabase.from('users').select('email, full_name').eq('id', uid).single();
  const email = b.email || prof?.email || '';
  if (!email) return { status: 400, body: { error: 'Email required — contact support' } };
  const np = (prof?.full_name || 'Member CNI').trim().split(' ');
  const natMobile = national(cc, b.mobile);
  const id = `dep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const base = process.env.APP_URL || '';
  log('cni.deposit-create', 'creating', { uid, amount: amt, id });

  let r;
  try {
    r = await post('/api/order/submit', {
      merchantId: CFG.merchantId, merchantOrderId: id, amount: fmtAmt(amt), currency: c.currency,
      remark: b.operator || 'mtn', sign: signCreate(id, amt), payType: 1,
      notifyUrl: base + '/api/payments/otpay-callback', callbackUrl: base + '/',
      firstName: np[0] || 'Member', lastName: np.slice(1).join(' ') || 'CNI', mobile: natMobile, email
    });
  } catch (e) {
    return { status: 502, body: { ok: false, error: e.timeout ? 'Gateway did not respond in 15s — try again' : 'Network error reaching gateway' } };
  }
  if (r.status !== 200 || !r.data || r.data.code !== 0) {
    log('cni.deposit-create', 'gateway rejected', { httpStatus: r.status, body: r.data });
    return { status: 502, body: { error: (r.data?.error || r.data?.msg || 'Gateway error') + (r.data?.code !== undefined ? ' [code ' + r.data.code + ']' : '') } };
  }
  await supabase.from('payment_transactions').insert({
    user_id: uid, kind: 'deposit', provider: 'otpay', mode: MODE, merchant_order_id: id,
    provider_order_id: String(r.data.data.orderId || ''), amount: amt, currency: c.currency,
    status: 'pending', country_code: cc, operator: b.operator || null, phone: b.mobile, email,
    meta: { h5Url: r.data.data.h5Url }
  });
  return { status: 200, body: { ok: true, merchantOrderId: id, h5Url: r.data.data.h5Url } };
}

// ---------- DEPOSIT QUERY ----------
async function depositQuery(supabase, uid, b) {
  if (!b.merchantOrderId) return { status: 400, body: { error: 'merchantOrderId required' } };
  const { data: tx } = await supabase.from('payment_transactions').select('*').eq('merchant_order_id', b.merchantOrderId).eq('user_id', uid).single();
  if (!tx) return { status: 404, body: { error: 'Order not found' } };
  let r;
  try { r = await get(`/api/order/status?merchantId=${CFG.merchantId}&merchantOrderId=${encodeURIComponent(b.merchantOrderId)}`); }
  catch (e) { return { status: 502, body: { error: e.timeout ? 'Gateway query timed out' : 'Gateway query network error' } }; }
  if (r.status !== 200 || !r.data || r.data.code !== 0) return { status: 502, body: { error: 'Gateway query failed' } };

  const q = r.data.data.status;
  let st = tx.status;
  if (tx.status === 'pending') {
    if (q === 1) {
      const pa = Number(r.data.data.payAmount || tx.amount);
      await creditDeposit({ supabase, user_id: tx.user_id, amount: pa, provider_ref: r.data.data.orderId, description: `CNI deposit (query) — ref ${r.data.data.orderId}` });
      st = 'paid';
      await supabase.from('payment_transactions').update({ status: 'paid', pay_amount: pa, provider_order_id: String(r.data.data.orderId || ''), updated_at: new Date().toISOString() }).eq('id', tx.id);
    } else if (q === 2) { st = 'failed'; await supabase.from('payment_transactions').update({ status: 'failed', updated_at: new Date().toISOString() }).eq('id', tx.id); }
    else if (q === 3) { st = 'refunded'; await supabase.from('payment_transactions').update({ status: 'refunded', updated_at: new Date().toISOString() }).eq('id', tx.id); }
  }
  return { status: 200, body: { ok: true, status: st, gatewayStatus: q } };
}

// ---------- ADMIN DEPOSIT ACTIONS ----------
async function adminDepositVerify(supabase, merchantOrderId) {
  const { data: tx } = await supabase.from('payment_transactions').select('*').eq('merchant_order_id', merchantOrderId).eq('kind', 'deposit').single();
  if (!tx) return { status: 404, body: { error: 'Transaction not found' } };
  if (tx.status !== 'pending') return { status: 400, body: { error: `Already ${tx.status}` } };
  let r;
  try { r = await get(`/api/order/status?merchantId=${CFG.merchantId}&merchantOrderId=${encodeURIComponent(merchantOrderId)}`); }
  catch (e) { return { status: 502, body: { error: 'Gateway query failed' } }; }
  if (r.status !== 200 || !r.data || r.data.code !== 0) return { status: 502, body: { error: 'Gateway query failed' } };
  const q = r.data.data.status;
  if (q === 1) {
    const pa = Number(r.data.data.payAmount || tx.amount);
    await creditDeposit({ supabase, user_id: tx.user_id, amount: pa, provider_ref: r.data.data.orderId, description: `CNI deposit (admin verify) — ref ${r.data.data.orderId}` });
    await supabase.from('payment_transactions').update({ status: 'paid', pay_amount: pa, updated_at: new Date().toISOString() }).eq('id', tx.id);
    return { status: 200, body: { ok: true, message: 'Verified & credited' } };
  }
  if (q === 2) { await supabase.from('payment_transactions').update({ status: 'failed', updated_at: new Date().toISOString() }).eq('id', tx.id); return { status: 200, body: { ok: true, message: 'Gateway says FAILED' } }; }
  if (q === 3) { await supabase.from('payment_transactions').update({ status: 'refunded', updated_at: new Date().toISOString() }).eq('id', tx.id); return { status: 200, body: { ok: true, message: 'Gateway says REFUNDED' } }; }
  return { status: 200, body: { ok: false, message: 'Still pending at gateway' } };
}
async function adminDepositCredit(supabase, merchantOrderId) {
  const { data: tx } = await supabase.from('payment_transactions').select('*').eq('merchant_order_id', merchantOrderId).eq('kind', 'deposit').single();
  if (!tx) return { status: 404, body: { error: 'Transaction not found' } };
  if (tx.status !== 'pending') return { status: 400, body: { error: `Already ${tx.status}` } };
  const pa = Number(tx.pay_amount || tx.amount);
  await creditDeposit({ supabase, user_id: tx.user_id, amount: pa, provider_ref: tx.provider_order_id, description: 'CNI deposit (admin force-credit)' });
  await supabase.from('payment_transactions').update({ status: 'paid', pay_amount: pa, updated_at: new Date().toISOString() }).eq('id', tx.id);
  return { status: 200, body: { ok: true, message: 'Force-credited' } };
}
async function adminDepositFail(supabase, merchantOrderId) {
  const { data: tx } = await supabase.from('payment_transactions').select('*').eq('merchant_order_id', merchantOrderId).eq('kind', 'deposit').single();
  if (!tx) return { status: 404, body: { error: 'Transaction not found' } };
  if (tx.status !== 'pending') return { status: 400, body: { error: `Already ${tx.status}` } };
  await supabase.from('payment_transactions').update({ status: 'failed', last_error: 'Marked failed by admin', updated_at: new Date().toISOString() }).eq('id', tx.id);
  return { status: 200, body: { ok: true, message: 'Marked failed' } };
}

// ---------- HANDLER ----------
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!CFG.payUrl || !CFG.merchantId || !CFG.appSecret) return res.status(500).json({ error: 'Gateway not configured' });

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const action = (req.body?.action || '').toString();
  try {
    if (action.startsWith('admin-')) {
      const admin = await adminCheck(supabase, req);
      if (!admin) return res.status(403).json({ error: 'Admin access required' });
      let result;
      if (action === 'admin-deposit-verify') result = await adminDepositVerify(supabase, req.body.merchantOrderId);
      else if (action === 'admin-deposit-credit') result = await adminDepositCredit(supabase, req.body.merchantOrderId);
      else if (action === 'admin-deposit-fail') result = await adminDepositFail(supabase, req.body.merchantOrderId);
      else result = { status: 400, body: { error: 'Unknown admin action' } };
      return res.status(result.status).json(result.body);
    }

    const token = (req.headers.authorization || '').replace('Bearer ', '');
    const { data } = await supabase.auth.getUser(token);
    if (!data?.user) return res.status(401).json({ error: 'Unauthorized' });
    const { data: prof } = await supabase.from('users').select('is_banned').eq('id', data.user.id).single();
    if (prof?.is_banned) return res.status(403).json({ error: 'Account suspended — contact support' });

    // 🛑 KILL-SWITCH: block new deposit orders when gateway disabled in Settings
    if (action === 'deposit-create') {
      const { data: st } = await supabase.from('platform_settings').select('otpay_enabled').eq('id', 1).single();
      if (st && st.otpay_enabled === false) return res.status(403).json({ error: 'Deposits are temporarily disabled' });
    }

    let result;
    if (action === 'deposit-create') result = await depositCreate(supabase, data.user.id, req.body);
    else if (action === 'deposit-query') result = await depositQuery(supabase, data.user.id, req.body);
    else if (action === 'country-validate') {
      const c = COUNTRY[req.body.country_code];
      result = c ? { status: 200, body: { ok: true, currency: c.currency } } : { status: 400, body: { ok: false, error: 'Unsupported country' } };
    }
    else result = { status: 400, body: { error: 'Unknown action' } };
    return res.status(result.status).json(result.body);
  } catch (e) {
    log('cni.otpay', 'exception', { action, error: e.message });
    return res.status(500).json({ error: e.message });
  }
};
