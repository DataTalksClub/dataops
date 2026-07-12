(function () {
  'use strict';

  var TOKEN_KEY = 'dataops_token';
  var USER_KEY = 'dataops_user';
  var LEGACY_TOKEN_KEY = 'datatasks_token';
  var LEGACY_USER_KEY = 'datatasks_user';

  function getToken() {
    var token = localStorage.getItem(TOKEN_KEY);
    if (token !== null) return token;

    var legacyToken = localStorage.getItem(LEGACY_TOKEN_KEY);
    if (legacyToken !== null) {
      localStorage.setItem(TOKEN_KEY, legacyToken);
    }
    return legacyToken;
  }

  function getAuthHeaders() {
    var token = getToken();
    var headers = { 'Content-Type': 'application/json' };
    if (token) {
      headers['Authorization'] = 'Bearer ' + token;
    }
    return headers;
  }

  function handleResponse(response, skipAuthRedirect) {
    // Handle 401 by clearing session and redirecting to sign-in
    // (only for authenticated routes, not for the login endpoint itself)
    if (response.status === 401 && !skipAuthRedirect) {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      localStorage.removeItem(LEGACY_TOKEN_KEY);
      localStorage.removeItem(LEGACY_USER_KEY);
      // Signal to the app to show sign-in form
      if (window._onUnauthorized) {
        window._onUnauthorized();
      }
      return response.text().then(function (text) {
        var msg;
        try {
          var parsed = JSON.parse(text);
          msg = parsed.error || 'Unauthorized';
        } catch (e) {
          msg = 'Unauthorized';
        }
        throw new Error(msg);
      });
    }

    if (!response.ok) {
      return response.text().then(function (text) {
        var msg;
        try {
          var parsed = JSON.parse(text);
          msg = parsed.error || response.statusText;
        } catch (e) {
          msg = response.statusText || 'Request failed';
        }
        throw new Error(msg);
      });
    }
    if (response.status === 204) {
      return null;
    }
    return response.json();
  }

  window.api = {
    auth: {
      login: function (email, password) {
        return fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email, password: password }),
        }).then(function (response) {
          // Don't redirect to sign-in on 401 for login endpoint
          return handleResponse(response, true);
        });
      },
      logout: function () {
        return fetch('/api/auth/logout', {
          method: 'POST',
          headers: getAuthHeaders(),
        }).then(handleResponse);
      },
    },

    me: function () {
      return fetch('/api/me', {
        headers: getAuthHeaders(),
      }).then(handleResponse);
    },

    tasks: {
      list: function (params) {
        var qs = new URLSearchParams(params || {}).toString();
        return fetch('/api/tasks' + (qs ? '?' + qs : ''), {
          headers: getAuthHeaders(),
        }).then(handleResponse);
      },
      get: function (id) {
        return fetch('/api/tasks/' + id, {
          headers: getAuthHeaders(),
        }).then(handleResponse);
      },
      create: function (data) {
        return fetch('/api/tasks', {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify(data),
        }).then(handleResponse);
      },
      update: function (id, data) {
        return fetch('/api/tasks/' + id, {
          method: 'PUT',
          headers: getAuthHeaders(),
          body: JSON.stringify(data),
        }).then(handleResponse);
      },
      markWaiting: function (id, data) {
        return fetch('/api/tasks/' + id + '/actions/mark-waiting', {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify(data),
        }).then(handleResponse);
      },
      followUpSent: function (id, data) {
        return fetch('/api/tasks/' + id + '/actions/follow-up-sent', {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify(data),
        }).then(handleResponse);
      },
      responseReceived: function (id, data) {
        return fetch('/api/tasks/' + id + '/actions/response-received', {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify(data),
        }).then(handleResponse);
      },
      unblocked: function (id, data) {
        return fetch('/api/tasks/' + id + '/actions/unblocked', {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify(data),
        }).then(handleResponse);
      },
      resolveDone: function (id, data) {
        return fetch('/api/tasks/' + id + '/actions/resolve-done', {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify(data),
        }).then(handleResponse);
      },
      delete: function (id) {
        return fetch('/api/tasks/' + id, {
          method: 'DELETE',
          headers: getAuthHeaders(),
        }).then(handleResponse);
      },
    },

    bundles: {
      list: function () {
        return fetch('/api/bundles', {
          headers: getAuthHeaders(),
        }).then(handleResponse);
      },
      get: function (id) {
        return fetch('/api/bundles/' + id, {
          headers: getAuthHeaders(),
        }).then(handleResponse);
      },
      create: function (data) {
        return fetch('/api/bundles', {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify(data),
        }).then(handleResponse);
      },
      update: function (id, data) {
        return fetch('/api/bundles/' + id, {
          method: 'PUT',
          headers: getAuthHeaders(),
          body: JSON.stringify(data),
        }).then(handleResponse);
      },
      delete: function (id) {
        return fetch('/api/bundles/' + id, {
          method: 'DELETE',
          headers: getAuthHeaders(),
        }).then(handleResponse);
      },
      tasks: function (id) {
        return fetch('/api/bundles/' + id + '/tasks', {
          headers: getAuthHeaders(),
        }).then(handleResponse);
      },
    },

    artifacts: {
      list: function (params) {
        var qs = new URLSearchParams(params || {}).toString();
        return fetch('/api/artifacts' + (qs ? '?' + qs : ''), {
          headers: getAuthHeaders(),
        }).then(handleResponse);
      },
      get: function (id) {
        return fetch('/api/artifacts/' + id, {
          headers: getAuthHeaders(),
        }).then(handleResponse);
      },
      create: function (data) {
        return fetch('/api/artifacts', {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify(data),
        }).then(handleResponse);
      },
      update: function (id, data) {
        return fetch('/api/artifacts/' + id, {
          method: 'PUT',
          headers: getAuthHeaders(),
          body: JSON.stringify(data),
        }).then(handleResponse);
      },
      attach: function (id, data) {
        return fetch('/api/artifacts/' + id + '/attach', {
          method: 'PUT',
          headers: getAuthHeaders(),
          body: JSON.stringify(data),
        }).then(handleResponse);
      },
      archive: function (id) {
        return fetch('/api/artifacts/' + id + '/archive', {
          method: 'PUT',
          headers: getAuthHeaders(),
        }).then(handleResponse);
      },
    },

    assistantJobs: {
      list: function (params) {
        var qs = new URLSearchParams(params || {}).toString();
        return fetch('/api/assistant-jobs' + (qs ? '?' + qs : ''), {
          headers: getAuthHeaders(),
        }).then(handleResponse);
      },
      get: function (id) {
        return fetch('/api/assistant-jobs/' + id, {
          headers: getAuthHeaders(),
        }).then(handleResponse);
      },
      create: function (data) {
        return fetch('/api/assistant-jobs', {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify(data),
        }).then(handleResponse);
      },
      update: function (id, data) {
        return fetch('/api/assistant-jobs/' + id, {
          method: 'PUT',
          headers: getAuthHeaders(),
          body: JSON.stringify(data),
        }).then(handleResponse);
      },
      submit: function (id) {
        return fetch('/api/assistant-jobs/' + id + '/submit', {
          method: 'POST',
          headers: getAuthHeaders(),
        }).then(handleResponse);
      },
      runDry: function (id) {
        return fetch('/api/assistant-jobs/' + id + '/run-dry', {
          method: 'POST',
          headers: getAuthHeaders(),
        }).then(handleResponse);
      },
      approve: function (id) {
        return fetch('/api/assistant-jobs/' + id + '/approve', {
          method: 'POST',
          headers: getAuthHeaders(),
        }).then(handleResponse);
      },
      reject: function (id, reason) {
        return fetch('/api/assistant-jobs/' + id + '/reject', {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({ reason: reason }),
        }).then(handleResponse);
      },
      retry: function (id) {
        return fetch('/api/assistant-jobs/' + id + '/retry', {
          method: 'POST',
          headers: getAuthHeaders(),
        }).then(handleResponse);
      },
      cancel: function (id) {
        return fetch('/api/assistant-jobs/' + id + '/cancel', {
          method: 'POST',
          headers: getAuthHeaders(),
        }).then(handleResponse);
      },
    },

    intake: {
      list: function (params) {
        var qs = new URLSearchParams(params || {}).toString();
        return fetch('/api/intake' + (qs ? '?' + qs : ''), {
          headers: getAuthHeaders(),
        }).then(handleResponse);
      },
      get: function (id) {
        return fetch('/api/intake/' + id, {
          headers: getAuthHeaders(),
        }).then(handleResponse);
      },
      create: function (data) {
        return fetch('/api/intake', {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify(data),
        }).then(handleResponse);
      },
      update: function (id, data) {
        return fetch('/api/intake/' + id, {
          method: 'PUT',
          headers: getAuthHeaders(),
          body: JSON.stringify(data),
        }).then(handleResponse);
      },
      attach: function (id, data) {
        return fetch('/api/intake/' + id + '/attach', {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify(data),
        }).then(handleResponse);
      },
      convertTask: function (id, data) {
        return fetch('/api/intake/' + id + '/convert-task', {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify(data),
        }).then(handleResponse);
      },
      markDuplicate: function (id, data) {
        return fetch('/api/intake/' + id + '/mark-duplicate', {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify(data),
        }).then(handleResponse);
      },
      ignore: function (id, reason) {
        return fetch('/api/intake/' + id + '/ignore', {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({ reason: reason }),
        }).then(handleResponse);
      },
      archive: function (id, reason) {
        return fetch('/api/intake/' + id + '/archive', {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({ reason: reason }),
        }).then(handleResponse);
      },
      block: function (id, data) {
        return fetch('/api/intake/' + id + '/block', {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify(data),
        }).then(handleResponse);
      },
      followUpSent: function (id, data) {
        return fetch('/api/intake/' + id + '/follow-up-sent', {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify(data),
        }).then(handleResponse);
      },
      responseReceived: function (id, data) {
        return fetch('/api/intake/' + id + '/response-received', {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify(data),
        }).then(handleResponse);
      },
      unblocked: function (id, data) {
        return fetch('/api/intake/' + id + '/unblocked', {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify(data),
        }).then(handleResponse);
      },
      prepareAssistant: function (id, data) {
        return fetch('/api/intake/' + id + '/prepare-assistant', {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify(data),
        }).then(handleResponse);
      },
    },

    templates: {
      list: function () {
        return fetch('/api/templates', {
          headers: getAuthHeaders(),
        }).then(handleResponse);
      },
      get: function (id) {
        return fetch('/api/templates/' + id, {
          headers: getAuthHeaders(),
        }).then(handleResponse);
      },
      create: function (data) {
        return fetch('/api/templates', {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify(data),
        }).then(handleResponse);
      },
      update: function (id, data) {
        return fetch('/api/templates/' + id, {
          method: 'PUT',
          headers: getAuthHeaders(),
          body: JSON.stringify(data),
        }).then(handleResponse);
      },
      delete: function (id) {
        return fetch('/api/templates/' + id, {
          method: 'DELETE',
          headers: getAuthHeaders(),
        }).then(handleResponse);
      },
    },

    users: {
      list: function () {
        return fetch('/api/users', {
          headers: getAuthHeaders(),
        }).then(handleResponse);
      },
      get: function (id) {
        return fetch('/api/users/' + id, {
          headers: getAuthHeaders(),
        }).then(handleResponse);
      },
    },

    recurring: {
      list: function () {
        return fetch('/api/recurring', {
          headers: getAuthHeaders(),
        }).then(handleResponse);
      },
      get: function (id) {
        return fetch('/api/recurring/' + id, {
          headers: getAuthHeaders(),
        }).then(handleResponse);
      },
      create: function (data) {
        return fetch('/api/recurring', {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify(data),
        }).then(handleResponse);
      },
      update: function (id, data) {
        return fetch('/api/recurring/' + id, {
          method: 'PUT',
          headers: getAuthHeaders(),
          body: JSON.stringify(data),
        }).then(handleResponse);
      },
      delete: function (id) {
        return fetch('/api/recurring/' + id, {
          method: 'DELETE',
          headers: getAuthHeaders(),
        }).then(handleResponse);
      },
      generate: function (data) {
        return fetch('/api/recurring/generate', {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify(data),
        }).then(handleResponse);
      },
    },

    notifications: {
      list: function () {
        return fetch('/api/notifications', {
          headers: getAuthHeaders(),
        }).then(handleResponse);
      },
      listAll: function () {
        return fetch('/api/notifications?all=true', {
          headers: getAuthHeaders(),
        }).then(handleResponse);
      },
      dismiss: function (id) {
        return fetch('/api/notifications/' + id + '/dismiss', {
          method: 'PUT',
          headers: getAuthHeaders(),
        }).then(handleResponse);
      },
      dismissAll: function () {
        return fetch('/api/notifications/dismiss-all', {
          method: 'PUT',
          headers: getAuthHeaders(),
        }).then(handleResponse);
      },
    },

    bookkeeping: {
      list: function () { return fetch('/api/bookkeeping/transactions', { headers: getAuthHeaders() }).then(handleResponse); },
      create: function (data) { return fetch('/api/bookkeeping/transactions', { method: 'POST', headers: getAuthHeaders(), body: JSON.stringify(data) }).then(handleResponse); },
      update: function (id, data) { return fetch('/api/bookkeeping/transactions/' + encodeURIComponent(id), { method: 'PUT', headers: getAuthHeaders(), body: JSON.stringify(data) }).then(handleResponse); },
      delete: function (id) { return fetch('/api/bookkeeping/transactions/' + encodeURIComponent(id), { method: 'DELETE', headers: getAuthHeaders() }).then(handleResponse); },
      listResource: function (name) { return fetch('/api/bookkeeping/' + name, { headers: getAuthHeaders() }).then(handleResponse); },
      createResource: function (name, data) { return fetch('/api/bookkeeping/' + name, { method: 'POST', headers: getAuthHeaders(), body: JSON.stringify(data) }).then(handleResponse); },
      deleteResource: function (name, id) { return fetch('/api/bookkeeping/' + name + '/' + encodeURIComponent(id), { method: 'DELETE', headers: getAuthHeaders() }).then(handleResponse); },
      prepareUpload: function (data) { return fetch('/api/bookkeeping/documents/upload', { method: 'POST', headers: getAuthHeaders(), body: JSON.stringify(data) }).then(handleResponse); },
      completeUpload: function (id) { return fetch('/api/bookkeeping/documents/' + encodeURIComponent(id) + '/complete', { method: 'POST', headers: getAuthHeaders() }).then(handleResponse); },
      downloadDocument: function (id) { return fetch('/api/bookkeeping/documents/' + encodeURIComponent(id) + '/download', { headers: getAuthHeaders() }).then(handleResponse); },
      createReport: function (data) { return fetch('/api/bookkeeping/reports/snapshot', { method: 'POST', headers: getAuthHeaders(), body: JSON.stringify(data) }).then(handleResponse); },
      archiveReport: function (id) { return fetch('/api/bookkeeping/reports/' + encodeURIComponent(id) + '/archive', { method: 'POST', headers: getAuthHeaders() }).then(handleResponse); },
      setupAccounts: function () { return fetch('/api/bookkeeping/accounts/setup', { method: 'POST', headers: getAuthHeaders() }).then(handleResponse); },
    },
    sponsorCrm: {
      list: function (resource, query) { return fetch('/api/sponsor-crm/' + resource + (query ? '?' + new URLSearchParams(query) : ''), { headers: getAuthHeaders() }).then(handleResponse); },
      get: function (resource, id) { return fetch('/api/sponsor-crm/' + resource + '/' + encodeURIComponent(id), { headers: getAuthHeaders() }).then(handleResponse); },
      create: function (resource, data) { return fetch('/api/sponsor-crm/' + resource, { method: 'POST', headers: getAuthHeaders(), body: JSON.stringify(data) }).then(handleResponse); },
      update: function (resource, id, data) { return fetch('/api/sponsor-crm/' + resource + '/' + encodeURIComponent(id), { method: 'PUT', headers: getAuthHeaders(), body: JSON.stringify(data) }).then(handleResponse); },
      archive: function (resource, id) { return fetch('/api/sponsor-crm/' + resource + '/' + encodeURIComponent(id), { method: 'DELETE', headers: getAuthHeaders() }).then(handleResponse); },
      history: function (id) { return fetch('/api/sponsor-crm/bookings/' + encodeURIComponent(id) + '/history', { headers: getAuthHeaders() }).then(handleResponse); },
      linkSchedule: function (id, data) { return fetch('/api/sponsor-crm/bookings/' + encodeURIComponent(id) + '/schedule-link', { method: 'PUT', headers: getAuthHeaders(), body: JSON.stringify(data) }).then(handleResponse); }
    },
    newsletterSlots:{list:function(query){return fetch('/api/newsletter-slots?'+new URLSearchParams(query||{}),{headers:getAuthHeaders()}).then(handleResponse);},create:function(data){return fetch('/api/newsletter-slots',{method:'POST',headers:getAuthHeaders(),body:JSON.stringify(data)}).then(handleResponse);},update:function(id,data){return fetch('/api/newsletter-slots/'+encodeURIComponent(id),{method:'PUT',headers:getAuthHeaders(),body:JSON.stringify(data)}).then(handleResponse);}},

    files: {
      upload: function (formData) {
        var token = getToken();
        var headers = {};
        if (token) {
          headers['Authorization'] = 'Bearer ' + token;
        }
        return fetch('/api/files', {
          method: 'POST',
          headers: headers,
          body: formData,
        }).then(handleResponse);
      },
      list: function (params) {
        var qs = new URLSearchParams(params || {}).toString();
        return fetch('/api/files' + (qs ? '?' + qs : ''), {
          headers: getAuthHeaders(),
        }).then(handleResponse);
      },
      get: function (id) {
        return fetch('/api/files/' + id, {
          headers: getAuthHeaders(),
        }).then(handleResponse);
      },
      delete: function (id) {
        return fetch('/api/files/' + id, {
          method: 'DELETE',
          headers: getAuthHeaders(),
        }).then(handleResponse);
      },
    },
  };
})();
