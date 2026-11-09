import { guardedFetchJson } from './core/guarded-fetch.js';
import { createContractSignPage } from './surfaces/operations/contract-sign.js';

async function request(path, options = {}) {
  const { response, data } = await guardedFetchJson(
    path,
    {
      ...options,
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        ...(options.headers || {}),
      },
    },
    { surface: 'contract-sign', check: `${options.method || 'GET'} /api/sponsor-contracts`, what: 'load the signing page' },
  );
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
document.documentElement.dataset.pageReady = 'true';
page.start();
