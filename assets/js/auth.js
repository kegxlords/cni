/* ============================================================
   CALMTEL NETWORK INTERNATIONAL — AUTH & UTILITIES
   File: assets/js/auth.js
   ============================================================ */
(function () {
  const IMPERSONATION_STATE_KEY = 'cni_impersonation_state';
  const IMPERSONATION_AUTH_STORAGE_KEY = 'cni-impersonation-auth-token';

  async function impersonationRequest(accessToken, body) {
    const response = await fetch('/api/admin/impersonate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + accessToken },
      body: JSON.stringify(body),
      cache: 'no-store'
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Impersonation request failed (HTTP ${response.status})`);
    return data;
  }

  const CniAuth = {
    _ensured: false,
    _banChecked: false,
    _banned: false,
    _toastTimer: null,

    // ---------- SESSION ----------
    async getSession() {
      try {
        const { data, error } = await window.sb.auth.getSession();
        if (error) { console.error('[CNI] Session error:', error); return null; }
        const session = data.session || null;
        if (session) {
          await this.ensureProfile(session);
          const allowed = await this.checkBan(session);
          if (!allowed) return null;
        }
        return session;
      } catch (e) {
        console.error('[CNI] Session exception:', e);
        return null;
      }
    },

    // ---------- BAN ENFORCEMENT ----------
    async checkBan(session) {
      if (this._banChecked) return !this._banned;
      this._banChecked = true;
      try {
        const { data } = await window.sb
          .from('users').select('is_banned, ban_reason')
          .eq('id', session.user.id).single();
        if (data && data.is_banned) {
          this._banned = true;
          this._showBanned(data.ban_reason);
          window.sb.auth.signOut().catch(() => {});
          return false;
        }
      } catch (e) { console.warn('[CNI] checkBan:', e.message); }
      return true;
    },

    _showBanned(reason) {
      if (document.getElementById('cniBanned')) return;
      const d = document.createElement('div');
      d.id = 'cniBanned';
      d.style.cssText = 'position:fixed;inset:0;z-index:9999;background:linear-gradient(180deg,#020B1F,#041230);display:flex;align-items:center;justify-content:center;padding:24px;font-family:Inter,sans-serif;';
      d.innerHTML = `
        <div style="max-width:380px;width:100%;background:rgba(6,20,48,.9);border:1px solid rgba(53,199,255,.35);border-radius:24px;padding:32px 26px;text-align:center;box-shadow:0 0 40px rgba(0,71,255,.4);">
          <div style="font-size:52px;">🚫</div>
          <h2 style="margin:12px 0 6px;font-size:22px;color:#fff;font-weight:900;font-family:Montserrat,sans-serif;">Account Suspended</h2>
          <p style="color:#8FA3C8;font-size:13px;line-height:1.6;margin:0 0 20px;">${reason ? 'Reason: ' + reason : 'Your account has been suspended by the administrator.'}</p>
          <button onclick="location.href='/'" style="width:100%;padding:14px;border:none;border-radius:14px;background:linear-gradient(135deg,#0033CC,#0047FF);color:#fff;font-weight:800;font-size:14px;cursor:pointer;font-family:inherit;">Back to Home</button>
        </div>`;
      document.body.appendChild(d);
    },

    // ---------- PROFILE / WALLET SELF-HEAL ----------
    async ensureProfile(session) {
      if (this._ensured) return;
      this._ensured = true;
      try {
        const { data } = await window.sb.from('users').select('id').eq('id', session.user.id).single();
        if (data) return;
        const code = 'CNI' + Math.random().toString(36).slice(2, 7).toUpperCase();
        const meta = session.user.user_metadata || {};
        const { error } = await window.sb.from('users').insert({
          id: session.user.id,
          email: session.user.email || '',
          full_name: meta.full_name || 'Member',
          phone: meta.phone || null,
          referral_code: code
        });
        if (error) throw error;
        await window.sb.from('wallets').insert({ user_id: session.user.id });
      } catch (e) { console.warn('[CNI] ensureProfile:', e.message); }
    },

    // ---------- GUARDS ----------
    async requireAuth() {
      const session = await this.getSession();
      if (!session) {
        if (window.CNI_IMPERSONATION_STATE || window.CNI_IMPERSONATION_EXPIRED_STATE) {
          this.stopImpersonating(window.CNI_IMPERSONATION_EXPIRED_STATE ? 'expired' : 'ended');
          return null;
        }
        if (!this._banned) window.location.href = '/';
        return null;
      }
      return session;
    },

    async adminGuard() {
      const s = await this.getSession();
      if (!s) {
        console.warn('[ADMIN] No session found, redirecting home.');
        location.href = '/';
        return null;
      }

      try {
        const { data: profile, error } = await window.sb
          .from('users')
          .select('is_admin')
          .eq('id', s.user.id)
          .maybeSingle();

        if (error) {
          console.error('[ADMIN] DB error checking admin:', error);
          location.href = '/dashboard';
          return null;
        }

        if (!profile || profile.is_admin !== true) {
          console.warn('[ADMIN] User is not an admin; redirecting to dashboard.', {
            uid: s.user.id,
            isAdminFlag: profile?.is_admin
          });
          location.href = '/dashboard';
          return null;
        }

        console.log('[ADMIN] Access granted for user:', s.user.id);
        return s;
      } catch (error) {
        console.error('[ADMIN] Unexpected exception in guard:', error);
        location.href = '/dashboard';
        return null;
      }
    },

    // ---------- ADMIN IMPERSONATION ----------
    async startImpersonation(targetUserId, targetName) {
      if (window.CNI_IMPERSONATION_STATE) throw new Error('An impersonation session is already active');
      if (!window.CNI_SUPABASE_URL || !window.CNI_SUPABASE_ANON_KEY || !window.supabase?.createClient) {
        throw new Error('Impersonation client is not available');
      }
      if (!window.confirm(`Start a 30-minute full impersonation of ${targetName || 'this user'}? All actions will be performed as that user.`)) return false;

      const { data: sessionData, error: sessionError } = await window.sb.auth.getSession();
      const adminSession = sessionData?.session;
      if (sessionError || !adminSession?.access_token) throw new Error('Your admin session has expired. Please sign in again.');

      let result;
      let targetClient;
      try {
        result = await impersonationRequest(adminSession.access_token, {
          action: 'start', target_user_id: targetUserId
        });
        window.sessionStorage.removeItem(IMPERSONATION_AUTH_STORAGE_KEY);
        targetClient = window.supabase.createClient(window.CNI_SUPABASE_URL, window.CNI_SUPABASE_ANON_KEY, {
          auth: {
            storage: window.sessionStorage,
            storageKey: IMPERSONATION_AUTH_STORAGE_KEY,
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: false
          }
        });
        const preferredType = ['email', 'magiclink'].includes(result.verification_type)
          ? result.verification_type : 'email';
        const types = [preferredType, preferredType === 'email' ? 'magiclink' : 'email'];
        let verifiedData = null;
        let verifyError = null;
        for (const type of types) {
          const attempt = await targetClient.auth.verifyOtp({ token_hash: result.token_hash, type });
          if (attempt.error) { verifyError = attempt.error; continue; }
          verifiedData = attempt.data;
          break;
        }
        if (!verifiedData) throw verifyError || new Error('Could not verify the one-time login link');
        if (verifiedData?.user?.id !== targetUserId) throw new Error('Supabase returned a different user session');

        const state = {
          audit_id: result.audit_id,
          target_user_id: result.target.id,
          target_name: result.target.name,
          expires_at: result.expires_at
        };
        window.sessionStorage.setItem(IMPERSONATION_STATE_KEY, JSON.stringify(state));
        window.location.replace('/dashboard');
        return true;
      } catch (error) {
        try { await targetClient?.auth.signOut({ scope: 'local' }); } catch (_) {}
        if (result?.audit_id) {
          try {
            await impersonationRequest(adminSession.access_token, {
              action: 'end', audit_id: result.audit_id, outcome: 'failed'
            });
          } catch (auditError) { console.error('[CNI] Could not close failed impersonation audit:', auditError); }
        }
        window.sessionStorage.removeItem(IMPERSONATION_STATE_KEY);
        window.sessionStorage.removeItem(IMPERSONATION_AUTH_STORAGE_KEY);
        throw new Error(error.message || 'Could not start impersonation');
      }
    },

    async stopImpersonating(reason = 'ended') {
      const state = window.CNI_IMPERSONATION_STATE || window.CNI_IMPERSONATION_EXPIRED_STATE;
      if (!state) return false;
      const adminClient = window.sbAdmin || window.sb;
      let adminSession = null;
      try {
        const { data } = await adminClient.auth.getSession();
        adminSession = data?.session || null;
      } catch (error) { console.warn('[CNI] Could not restore admin session:', error); }

      if (adminSession?.access_token && state.audit_id) {
        try {
          await impersonationRequest(adminSession.access_token, {
            action: 'end', audit_id: state.audit_id,
            outcome: reason === 'expired' ? 'expired' : 'ended'
          });
        } catch (error) { console.error('[CNI] Could not close impersonation audit:', error); }
      }

      if (window.CNI_IMPERSONATION_STATE) {
        try { await window.sb?.auth.signOut({ scope: 'local' }); } catch (error) { console.warn('[CNI] Could not revoke impersonated session:', error); }
      }
      window.sessionStorage.removeItem(IMPERSONATION_STATE_KEY);
      window.sessionStorage.removeItem(IMPERSONATION_AUTH_STORAGE_KEY);
      window.CNI_IMPERSONATION_STATE = null;
      window.CNI_IMPERSONATION_EXPIRED_STATE = null;
      window.location.replace(adminSession ? '/admin/users' : '/');
      return true;
    },

    // ---------- LOGIN ----------
    async login(email, password) {
      const { data, error } = await window.sb.auth.signInWithPassword({ email, password });
      if (error) throw new Error(error.message || 'Login failed');
      try {
        const { data: prof } = await window.sb
          .from('users').select('is_banned, ban_reason')
          .eq('id', data.user.id).single();
        if (prof && prof.is_banned) {
          await window.sb.auth.signOut();
          throw new Error('Account suspended' + (prof.ban_reason ? ': ' + prof.ban_reason : ' — contact support'));
        }
      } catch (e) {
        if (/Account suspended/.test(e.message || '')) throw e;
      }
      return data;
    },

    // ---------- REGISTER (robust error extraction) ----------
    async register(full_name, email, phone, password, referral_code) {
      let res;
      try {
        res = await fetch('/api/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ action: 'register', full_name, email, phone, password, referral_code })
        });
      } catch (e) {
        console.error('[CNI] register network error:', e);
        throw new Error('Network error — check your connection and retry');
      }

      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) {
        console.error('[CNI] register non-JSON response:', res.status, ct);
        throw new Error('Server error (HTTP ' + res.status + ') — please try again');
      }

      let data = {};
      try { data = await res.json(); } catch (e) { data = {}; }

      if (!res.ok || !data.ok) {
        const e = data.error;
        const msg = typeof e === 'string'
          ? e
          : (e?.message || e?.error_description || e?.msg || (e ? JSON.stringify(e) : '') || ('Registration failed (HTTP ' + res.status + ')'));
        console.error('[CNI] register error payload:', data);
        throw new Error(msg);
      }
      return data;
    },

    // ---------- LOGOUT ----------
    async logout(redirect = '/') {
      if (window.CNI_IMPERSONATION_STATE || window.CNI_IMPERSONATION_EXPIRED_STATE) {
        return this.stopImpersonating('ended');
      }
      this._ensured = false;
      this._banChecked = false;
      this._banned = false;
      await window.sb.auth.signOut();
      window.location.href = redirect;
    },

    // ---------- DATA HELPERS ----------
    async getProfile(uid) {
      const { data } = await window.sb.from('users').select('*').eq('id', uid).single();
      return data;
    },
    async getWallet(uid) {
      const { data } = await window.sb.from('wallets').select('*').eq('user_id', uid).single();
      return data;
    },

    // ---------- FORMATTERS / UI ----------
    money(n) { return Number(n || 0).toLocaleString() + ' FCFA'; },

    timeAgo(dateStr) {
      const d = new Date(dateStr);
      const s = Math.floor((Date.now() - d.getTime()) / 1000);
      if (s < 60) return 'Just now';
      const m = Math.floor(s / 60);  if (m < 60) return m + 'm ago';
      const h = Math.floor(m / 60);  if (h < 24) return h + 'h ago';
      const dy = Math.floor(h / 24); if (dy < 30) return dy + 'd ago';
      return d.toLocaleDateString();
    },

    async copy(text, msg = 'Copied') {
      try { await navigator.clipboard.writeText(text); this.toast(msg); }
      catch (e) { this.toast(text); }
    },

    toast(message, type = 'success') {
      let toast = document.getElementById('toast');
      if (!toast) {
        toast = document.createElement('div');
        toast.id = 'toast';
        document.body.appendChild(toast);
      }
      const text = typeof message === 'string' ? message : (message?.message || JSON.stringify(message) || 'Done');
      toast.textContent = text;
      toast.className = type === 'error' ? 'show err' : 'show';
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => { toast.className = ''; }, 3500);
    }
  };

  window.CniAuth = CniAuth;

  const activeImpersonation = window.CNI_IMPERSONATION_STATE;
  if (activeImpersonation) {
    const remainingMs = Date.parse(activeImpersonation.expires_at) - Date.now();
    window.setTimeout(() => CniAuth.stopImpersonating('expired'), Math.max(0, remainingMs));
  } else if (window.CNI_IMPERSONATION_EXPIRED_STATE) {
    window.setTimeout(() => CniAuth.stopImpersonating('expired'), 0);
  }
})();
