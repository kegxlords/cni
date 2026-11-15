const { createClient } = require('@supabase/supabase-js');

async function requireAdmin(supabase, req) {
  const authorization = req.headers.authorization || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  const { data: profile, error: profileError } = await supabase
    .from('users').select('is_admin').eq('id', data.user.id).maybeSingle();
  if (profileError) throw new Error('Could not verify admin role');
  return profile?.is_admin ? data.user : null;
}

async function rejectAndRefund(supabase, requestId) {
  // Claim once to prevent concurrent admins from refunding the same withdrawal twice.
  const { data: rejected, error: statusError } = await supabase.from('withdrawal_requests')
    .update({ status: 'rejected', admin_note: 'Rejected by admin — refunded' })
    .eq('id', requestId).in('status', ['pending', 'sent']).select('*').maybeSingle();
  if (statusError) throw new Error('Could not reject withdrawal: ' + statusError.message);
  if (!rejected) return false;

  const { data: wallet, error: walletError } = await supabase.from('wallets')
    .select('*').eq('user_id', rejected.user_id).maybeSingle();
  if (walletError) throw new Error('Withdrawal was rejected, but the member wallet could not be loaded: ' + walletError.message);
  if (!wallet) throw new Error('Withdrawal was rejected, but the member wallet was not found');

  const refundAmount = Number(rejected.amount);
  if (!Number.isFinite(refundAmount) || refundAmount <= 0) throw new Error('Withdrawal was rejected, but its refund amount is invalid');
  const balanceAfter = Number(wallet.balance || 0) + refundAmount;
  const { error: walletUpdateError } = await supabase.from('wallets').update({
    balance: balanceAfter,
    updated_at: new Date().toISOString()
  }).eq('user_id', rejected.user_id);
  if (walletUpdateError) throw new Error('Withdrawal was rejected, but wallet refund failed: ' + walletUpdateError.message);

  const { error: ledgerError } = await supabase.from('wallet_transactions').insert({
    user_id: rejected.user_id,
    type: 'withdrawal_refund',
    amount: refundAmount,
    description: 'Withdrawal rejected by admin — refund',
    balance_after: balanceAfter
  });
  if (ledgerError) throw new Error('Withdrawal was rejected and wallet credited, but refund logging failed: ' + ledgerError.message);
  return true;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) return res.status(500).json({ ok: false, error: 'Withdrawal service is not configured' });
  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });

  try {
    const admin = await requireAdmin(supabase, req);
    if (!admin) return res.status(403).json({ ok: false, error: 'Admin access required' });
    const { action, request_id: requestId } = req.body || {};
    if (!requestId || !['approve', 'reject'].includes(action)) {
      return res.status(400).json({ ok: false, error: 'A withdrawal ID and approve/reject action are required' });
    }

    if (action === 'approve') {
      const { data: approved, error } = await supabase.from('withdrawal_requests').update({
        status: 'approved',
        admin_note: 'Approved by admin — manually processed'
      }).eq('id', requestId).in('status', ['pending', 'sent']).select('id').maybeSingle();
      if (error) throw new Error('Could not approve withdrawal: ' + error.message);
      if (!approved) return res.status(409).json({ ok: false, error: 'This withdrawal was already processed' });
      return res.status(200).json({ ok: true, message: 'Withdrawal approved' });
    }

    const refunded = await rejectAndRefund(supabase, requestId);
    if (!refunded) return res.status(409).json({ ok: false, error: 'This withdrawal was already processed' });
    return res.status(200).json({ ok: true, message: 'Withdrawal rejected and refunded' });
  } catch (error) {
    console.error('[withdraw/manage] request failed:', error);
    return res.status(500).json({ ok: false, error: error.message || 'Could not process withdrawal' });
  }
};
