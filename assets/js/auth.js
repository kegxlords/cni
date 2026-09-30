/* ============================================================
   CALMTEL NETWORK INTERNATIONAL — AUTH & UTILITIES
   File: assets/js/auth.js
   ============================================================ */
(function () {
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
        if (!this._banned) window.location.href = '/';
        return null;
      }
      return session;
    },

    async adminGuard() {
      const s = await this.getSession();
      if (!s) { location.href = '/'; return null; }
      const { data: p } = await window.sb.from('users').select('is_admin').eq('id', s.user.id).single();
      if (!p || !p.is_admin) { location.href = '/dashboard'; return null; }
      return s;
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
})();
