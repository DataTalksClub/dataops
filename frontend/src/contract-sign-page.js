import { createContractSignPage } from './surfaces/operations/contract-sign.js';

async function request(path, options = {}) {
  const response = await fetch(/work, {
    ...options,
    cache: 'no-store',
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || 'Signing request failed');
    error.status = response.status;
    error.code = data.code || '';
    error.retryAfter = Number(response.headers.get('retry-after')) || Number(data.retryAfterSeconds) || 60;
    throw error;
  }
  return data;
}

const page = createContractSignPage({
  documentRef: document,
  request,
  locationRef: location,
});
page.start();
