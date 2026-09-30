// assets/js/admin-api.js — authenticated reads from the admin-only API.
(function () {
  async function get(action, params = {}) {
    const { data, error } = await window.sb.auth.getSession();
    if (error) throw error;
    const accessToken = data.session?.access_token;
    if (!accessToken) throw new Error('Your session has expired. Please sign in again.');

    const query = new URLSearchParams({ action, ...params });
    let response;
    try {
      response = await fetch(`/api/admin/data?${query.toString()}`, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
        cache: 'no-store'
      });
    } catch {
      throw new Error('Could not reach the admin data service. Check your connection and retry.');
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      throw new Error(`Admin data service returned an invalid response (HTTP ${response.status}).`);
    }
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Admin request failed (HTTP ${response.status}).`);
    return payload;
  }

  window.CniAdminApi = Object.freeze({ get });
})();
