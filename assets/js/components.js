/* ============================================================
   CALMTEL NETWORK INTERNATIONAL — SHARED UI COMPONENTS
   File: assets/js/components.js
   ============================================================ */
(function () {
  const CniUI = {
    // ---------- USER HEADER ----------
    header(session, profile) {
      const el = document.getElementById('app-header');
      if (!el) return;
      const right = session
        ? `<span class="cni-user">${(profile?.full_name || 'Member').split(' ')[0].toUpperCase()}</span>
           <span class="chip vip">VIP ${profile?.vip_level || 0}</span>
           <button class="cni-iconbtn" onclick="CniAuth.logout()" title="Logout">⏻</button>`
        : `<a class="btn sm ghost" href="/">Login</a>
           <a class="btn sm cyan" href="/register">Join</a>`;
      el.innerHTML = `
        <header class="cni-head">
          <div class="cni-logo">🌐</div>
          <div class="cni-brand"><b>CALMTEL</b><span>NETWORK INTERNATIONAL</span></div>
          <div class="right">${right}</div>
        </header>`;
    },

    // ---------- BOTTOM NAV (user area) ----------
    nav() {
      const el = document.getElementById('app-footer');
      if (!el) return;
      const path = location.pathname;
      const items = [
        ['/dashboard', '🏠', 'Home'],
        ['/invest', '📈', 'Invest'],
        ['/withdraw', '💸', 'Withdraw'],
        ['/team', '👥', 'Team'],
        ['/profile', '👤', 'Profile']
      ];
      el.innerHTML = `<nav class="cni-nav">` + items.map(([href, ic, lbl]) =>
        `<a href="${href}" class="${path.startsWith(href) ? 'on' : ''}"><span class="ic">${ic}</span>${lbl}</a>`
      ).join('') + `</nav>`;
    },

    // ---------- ADMIN CHIP NAV ----------
    adminNav(active) {
      const el = document.getElementById('adm-nav');
      if (!el) return;
      const items = [
        ['overview', '/admin', 'Overview'],
        ['withdrawals', '/admin/withdrawals', 'Withdrawals'],
        ['deposits', '/admin/deposits', 'Deposits'],
        ['users', '/admin/users', 'Users'],
        ['settings', '/admin/settings', 'Settings']
      ];
      el.innerHTML = `<nav class="adm-nav">` + items.map(([key, href, lbl]) =>
        `<a class="adm-chip ${key === active ? 'on' : ''}" href="${href}">${lbl}</a>`
      ).join('') + `</nav>`;
    }
  };

  window.CniUI = CniUI;
})();
