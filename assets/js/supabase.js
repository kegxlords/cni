// assets/js/supabase.js — CNI Supabase client with isolated admin impersonation storage.
(function () {
  const url = 'https://ayycdulxyhnzutkcuobn.supabase.co';
  const anonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF5eWNkdWx4eWhuenV0a2N1b2JuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA2OTY1ODYsImV4cCI6MjEwNjI3MjU4Nn0.xcfUq-__94LOQUnmuUisNs2HWBTOYkNYWwOLwJLG-tg';
  const stateKey = 'cni_impersonation_state';
  const authStorageKey = 'cni-impersonation-auth-token';

  window.CNI_SUPABASE_URL = url;
  window.CNI_SUPABASE_ANON_KEY = anonKey;
  window.CNI_IMPERSONATION_STATE_KEY = stateKey;
  window.CNI_IMPERSONATION_AUTH_STORAGE_KEY = authStorageKey;

  let state = null;
  try {
    const raw = window.sessionStorage.getItem(stateKey);
    state = raw ? JSON.parse(raw) : null;
  } catch (error) {
    console.warn('[CNI] Could not read impersonation session state:', error);
    try {
      window.sessionStorage.removeItem(stateKey);
      window.sessionStorage.removeItem(authStorageKey);
    } catch (_) {}
  }

  const expiresAt = state ? Date.parse(state.expires_at) : NaN;
  if (state && Number.isFinite(expiresAt) && expiresAt > Date.now()) {
    window.CNI_IMPERSONATION_STATE = state;
    // Keep the admin's ordinary localStorage session intact. The target user's
    // real Supabase session is stored only in this tab's sessionStorage.
    window.sbAdmin = supabase.createClient(url, anonKey);
    window.sb = supabase.createClient(url, anonKey, {
      auth: {
        storage: window.sessionStorage,
        storageKey: authStorageKey,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false
      }
    });
  } else {
    if (state) {
      window.CNI_IMPERSONATION_EXPIRED_STATE = state;
      window.sessionStorage.removeItem(stateKey);
      window.sessionStorage.removeItem(authStorageKey);
    } else {
      try { window.sessionStorage.removeItem(authStorageKey); } catch (_) {}
    }
    window.sb = supabase.createClient(url, anonKey);
    if (window.CNI_IMPERSONATION_EXPIRED_STATE) window.sbAdmin = window.sb;
  }
})();
