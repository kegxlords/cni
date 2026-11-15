const { createClient } = require('@supabase/supabase-js');
const safe200 = (res, msg) => res.status(200).json({ ok: true, msg });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handleExternalWebhook(req, res, supabase, externalId) {
  const body = req.body || {};
  const requestId = externalId || body.request_id || body.id || body.withdrawal_id;
  const rawStatus = body.status ?? body.state ?? body.result ?? body.payment_status ?? body.tx_status ??
    (body.data ? (body.data.status ?? body.data.state) : undefined) ?? '';
  const status = String(rawStatus).toLowerCase();
  console.log('[cni-external] routed', JSON.stringify({ requestId, status, keys: Object.keys(body) }));
  if (!requestId) return res.status(400).json({ ok: false, error: 'request_id missing' });

  const { data: request } = await supabase.from('withdrawal_requests').select('*').eq('id', requestId).maybeSingle();
  if (!request) return safe200(res, 'external: withdrawal not found');
  const isPaid = ['paid', 'payed', 'success', 'successful', '1', 'approved', 'completed', 'complete', 'done', 'ok', 'credited'].includes(status);
  const isFailed = ['failed', 'failure', 'rejected', 'reject', 'error', '2', 'declined', 'cancelled', 'canceled', 'refunded', 'expired'].includes(status);
  if (!isPaid && !isFailed) return safe200(res, 'external: status ignored');
  if (request.status === 'approved' || request.status === 'rejected') return safe200(res, `external: already ${request.status}`);

  if (isPaid) {
    await supabase.from('withdrawal_requests').update({ status: 'approved', admin_note: 'Auto-approved via pcmedia webhook' }).eq('id', requestId);
    return safe200(res, 'external: approved');
  }
  const { data: flipped } = await supabase.from('withdrawal_requests')
    .update({ status: 'rejected', admin_note: 'pcmedia reported failure — refunded' })
    .eq('id', requestId).in('status', ['pending', 'sent']).select();
  if (flipped && flipped.length) {
    const { data: wallet } = await supabase.from('wallets').select('*').eq('user_id', request.user_id).maybeSingle();
    if (wallet) {
      const newBalance = Number(wallet.balance) + Number(request.amount);
      await supabase.from('wallets').update({ balance: newBalance, updated_at: new Date().toISOString() }).eq('user_id', request.user_id);
      await supabase.from('wallet_transactions').insert({
        user_id: request.user_id, type: 'withdrawal_refund', amount: Number(request.amount),
        description: 'pcmedia payout failed — refund', balance_after: newBalance
      });
    }
    return safe200(res, 'external: failed & refunded');
  }
  return safe200(res, 'external: failed (already settled)');
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const body = req.body || {};
  const signatureHeader = req.headers['x-gff-signature'];
  const externalId = body.request_id || body.withdrawal_id ||
    (UUID_RE.test(String(body.merchantOrderId || '')) ? body.merchantOrderId : null) ||
    (UUID_RE.test(String(body.id || '')) ? body.id : null);
  if (!body.action && (signatureHeader !== undefined || (externalId && !body.sign))) {
    return handleExternalWebhook(req, res, supabase, externalId);
  }
  return safe200(res, 'ignored: gateway payments have been retired');
};
