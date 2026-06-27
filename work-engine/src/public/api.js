(function () {
  'use strict';

  var TOKEN_KEY = 'datatasks_token';
  var USER_KEY = 'datatasks_user';

  function getToken() {
    return localStorage.getItem(TOKEN_KEY);
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
