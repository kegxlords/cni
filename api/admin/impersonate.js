// api/admin/impersonate.js — audited admin-to-user session switching.
const { createClient } = require('@supabase/supabase-js');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const END_RESULTS = new Set(['ended', 'expired', 'cancelled', 'failed']);

async function getAdmin(supabase, req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return null;
  const { data: auth, error } = await supabase.auth.getUser(token);
  if (error || !auth?.user) return null;
  const { data: profile, error: profileError } = await supabase.from('users')
    .select('is_admin').eq('id', auth.user.id).maybeSingle();
  if (profileError) throw new Error('Unable to verify admin role');
  return profile?.is_admin ? auth.user : null;
}

async function closeAudit(supabase, { auditId, adminId, result }) {
  if (!UUID_RE.test(String(auditId || '')) || !END_RESULTS.has(result)) {
    return { status: 400, body: { error: 'Invalid audit close request' } };
  }
  const { data, error } = await supabase.from('admin_impersonation_audit')
    .update({ outcome: result, ended_at: new Date().toISOString() })
    .eq('id', auditId).eq('admin_user_id', adminId).eq('outcome', 'active')
    .select('id').maybeSingle();
  if (error) throw new Error('Unable to close impersonation audit');
  return resJson(200, { ok: true, alreadyClosed: !data });
}

function resJson(status, body) { return { status, body }; }

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return res.status(500).json({ error: 'Impersonation service is not configured' });
  const supabase = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  try {
    const admin = await getAdmin(supabase, req);
    if (!admin) return res.status(403).json({ error: 'Admin access required' });

    const { action, target_user_id: targetId, audit_id: auditId, outcome } = req.body || {};
    if (action === 'end') {
      const result = await closeAudit(supabase, { auditId, adminId: admin.id, result: outcome || 'ended' });
      return res.status(result.status).json(result.body);
    }
    if (action !== 'start') return res.status(400).json({ error: 'Unknown impersonation action' });
    if (!UUID_RE.test(String(targetId || '')) || targetId === admin.id) {
      return res.status(400).json({ error: 'Invalid user to impersonate' });
    }

    const { data: profile, error: profileError } = await supabase.from('users')
      .select('id, full_name, is_admin, is_banned').eq('id', targetId).maybeSingle();
    if (profileError) throw new Error('Unable to load target account');
    if (!profile) return res.status(404).json({ error: 'User not found' });
    if (profile.is_admin) return res.status(403).json({ error: 'Admin accounts cannot be impersonated' });
    if (profile.is_banned) return res.status(403).json({ error: 'Banned accounts cannot be impersonated' });

    const { data: targetAuth, error: targetAuthError } = await supabase.auth.admin.getUserById(targetId);
    const email = targetAuth?.user?.email;
    if (targetAuthError || !email) return res.status(404).json({ error: 'User authentication record not found' });

    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const { data: audit, error: auditError } = await supabase.from('admin_impersonation_audit')
      .insert({ admin_user_id: admin.id, target_user_id: targetId, outcome: 'active', expires_at: expiresAt })
      .select('id').single();
    if (auditError || !audit?.id) {
      console.error('[admin/impersonate] audit insert failed:', auditError?.message);
      return res.status(503).json({ error: 'Impersonation audit storage is unavailable; apply the supplied migration first' });
    }

    // generateLink returns a one-time token; it does not send the email itself.
    const { data: link, error: linkError } = await supabase.auth.admin.generateLink({ type: 'magiclink', email });
    const tokenHash = link?.properties?.hashed_token;
    if (linkError || !tokenHash) {
      await closeAudit(supabase, { auditId: audit.id, adminId: admin.id, result: 'failed' });
      console.error('[admin/impersonate] link generation failed:', linkError?.message || 'missing hashed token');
      return res.status(502).json({ error: 'Could not start the impersonation session' });
    }

    console.info('[admin/impersonate] started', JSON.stringify({ auditId: audit.id, adminId: admin.id, targetId, expiresAt }));
    return res.status(200).json({
      ok: true,
      audit_id: audit.id,
      target: { id: targetId, name: profile.full_name || targetAuth.user.user_metadata?.full_name || 'Member' },
      expires_at: expiresAt,
      token_hash: tokenHash,
      verification_type: link.properties.verification_type || 'magiclink'
    });
  } catch (error) {
    console.error('[admin/impersonate] request failed:', error);
    return res.status(500).json({ error: 'Could not complete impersonation request' });
  }
};
