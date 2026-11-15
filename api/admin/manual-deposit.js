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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return res.status(500).json({ ok: false, error: 'Admin service is not configured' });
  const supabase = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  try {
    const admin = await requireAdmin(supabase, req);
    if (!admin) return res.status(403).json({ ok: false, error: 'Admin access required' });

    const { action, transaction_id: transactionId, reason } = req.body || {};
    if (!transactionId || !['approve', 'reject'].includes(action)) {
      return res.status(400).json({ ok: false, error: 'A transaction ID and valid action are required' });
    }

    const { data: tx, error: txError } = await supabase.from('payment_transactions')
      .select('id, user_id, amount, status, kind')
      .eq('id', transactionId).eq('kind', 'deposit').maybeSingle();
    if (txError) throw new Error('Could not load deposit request');
    if (!tx) return res.status(404).json({ ok: false, error: 'Deposit request not found' });
    if (tx.status !== 'pending') return res.status(409).json({ ok: false, error: `Deposit is already ${tx.status}` });

    if (action === 'reject') {
      const { data: rejected, error } = await supabase.from('payment_transactions')
        .update({ status: 'rejected', admin_note: String(reason || '').trim() || 'Rejected by admin', processed_by: admin.id, processed_at: new Date().toISOString() })
        .eq('id', transactionId).eq('status', 'pending').select('id').maybeSingle();
      if (error) throw new Error('Could not reject deposit: ' + error.message);
      if (!rejected) return res.status(409).json({ ok: false, error: 'This deposit was already processed' });
      return res.status(200).json({ ok: true, message: 'Deposit rejected' });
    }

    const amount = Number(tx.amount);
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ ok: false, error: 'Deposit amount is invalid' });

    // Claim the request before touching the wallet so two admins cannot credit it twice.
    const { data: claimed, error: claimError } = await supabase.from('payment_transactions')
      .update({ status: 'processing', processed_by: admin.id })
      .eq('id', transactionId).eq('status', 'pending').select('id').maybeSingle();
    if (claimError) throw new Error('Could not claim deposit: ' + claimError.message);
    if (!claimed) return res.status(409).json({ ok: false, error: 'This deposit was already processed' });

    let walletUpdated = false;
    try {
      let { data: wallet, error: walletError } = await supabase.from('wallets')
        .select('*').eq('user_id', tx.user_id).maybeSingle();
      if (walletError) throw new Error('Could not load member wallet: ' + walletError.message);
      if (!wallet) {
        const { data: created, error } = await supabase.from('wallets').insert({
          user_id: tx.user_id, balance: 0, total_deposit: 0, total_profit: 0,
          total_referral_earnings: 0, updated_at: new Date().toISOString()
        }).select('*').single();
        if (error) throw new Error('Could not create member wallet: ' + error.message);
        wallet = created;
      }

      const newBalance = Number(wallet.balance || 0) + amount;
      const { error: updateWalletError } = await supabase.from('wallets').update({
        balance: newBalance,
        total_deposit: Number(wallet.total_deposit || 0) + amount,
        updated_at: new Date().toISOString()
      }).eq('user_id', tx.user_id);
      if (updateWalletError) throw new Error('Could not update member wallet: ' + updateWalletError.message);
      walletUpdated = true;

      const { error: ledgerError } = await supabase.from('wallet_transactions').insert({
        user_id: tx.user_id,
        type: 'deposit',
        amount,
        description: `Manual bank transfer deposit #${tx.id}`,
        balance_after: newBalance
      });
      if (ledgerError) throw new Error('Wallet updated, but transaction logging needs review: ' + ledgerError.message);

      const [{ data: settings, error: settingsError }, { data: member, error: memberError }] = await Promise.all([
        supabase.from('platform_settings').select('referral_bonus_percent').eq('id', 1).maybeSingle(),
        supabase.from('users').select('referred_by').eq('id', tx.user_id).maybeSingle()
      ]);
      if (settingsError) throw new Error('Could not read referral settings: ' + settingsError.message);
      if (memberError) throw new Error('Could not read member referral: ' + memberError.message);

      const bonusPercent = Number(settings?.referral_bonus_percent ?? 30);
      if (member?.referred_by && bonusPercent > 0) {
        const bonus = Math.round(amount * bonusPercent / 100);
        const { data: refWallet, error: refWalletError } = await supabase.from('wallets')
          .select('*').eq('user_id', member.referred_by).maybeSingle();
        if (refWalletError) throw new Error('Could not load referrer wallet: ' + refWalletError.message);
        if (refWallet) {
          const refBalance = Number(refWallet.balance || 0) + bonus;
          const { error: refUpdateError } = await supabase.from('wallets').update({
            balance: refBalance,
            total_referral_earnings: Number(refWallet.total_referral_earnings || 0) + bonus,
            updated_at: new Date().toISOString()
          }).eq('user_id', member.referred_by);
          if (refUpdateError) throw new Error('Could not update referrer wallet: ' + refUpdateError.message);
          const { error: refLedgerError } = await supabase.from('wallet_transactions').insert({
            user_id: member.referred_by,
            type: 'referral_bonus',
            amount: bonus,
            description: `${bonusPercent}% commission on downline deposit [${tx.user_id}]`,
            balance_after: refBalance
          });
          if (refLedgerError) throw new Error('Referrer wallet updated, but bonus logging needs review: ' + refLedgerError.message);
        }
      }

      const { data: settled, error: settleError } = await supabase.from('payment_transactions').update({
        status: 'paid',
        processed_at: new Date().toISOString(),
        admin_note: 'Manual bank transfer verified and approved'
      }).eq('id', transactionId).eq('status', 'processing').select('id').maybeSingle();
      if (settleError) throw new Error('Wallet credited, but deposit status needs review: ' + settleError.message);
      if (!settled) throw new Error('Wallet credited, but deposit status could not be finalized. Please review this transaction.');
      return res.status(200).json({ ok: true, message: 'Manual deposit approved and credited' });
    } catch (error) {
      // Once the wallet has changed, keep the request claimed to prevent duplicate credits.
      if (!walletUpdated) {
        await supabase.from('payment_transactions').update({ status: 'pending', processed_by: null })
          .eq('id', transactionId).eq('status', 'processing');
      }
      throw error;
    }
  } catch (error) {
    console.error('[admin/manual-deposit] request failed:', error);
    return res.status(500).json({ ok: false, error: error.message || 'Could not process deposit' });
  }
};
