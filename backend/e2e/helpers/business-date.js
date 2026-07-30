const BERLIN_TIME_ZONE = 'Europe/Berlin';
const BERLIN_MIDNIGHT_BOUNDARY_INSTANT = '2026-07-30T22:30:00.000Z';

const berlinDateFormatter = new Intl.DateTimeFormat('en', {
  timeZone: BERLIN_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function berlinBusinessDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const parts = {};
  for (const part of berlinDateFormatter.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  return parts.year + '-' + parts.month + '-' + parts.day;
}

function offsetBusinessDate(value, days) {
  const datePart = berlinBusinessDate(value);
  if (!datePart) return '';
  const date = new Date(datePart + 'T00:00:00.000Z');
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function installBundleCreatedAtOverride(page, bundleId, createdAt) {
  await page.route(
    (url) => url.pathname === '/api/bundles' || url.pathname === '/api/bundles/' + bundleId,
    async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }

      const response = await route.fetch();
      const body = await response.json();
      if (Array.isArray(body.bundles)) {
        body.bundles = body.bundles.map((bundle) =>
          bundle.id === bundleId ? { ...bundle, createdAt } : bundle
        );
      }
      if (body.bundle && body.bundle.id === bundleId) {
        body.bundle = { ...body.bundle, createdAt };
      }
      await route.fulfill({ response, json: body });
    }
  );
}

module.exports = {
  BERLIN_MIDNIGHT_BOUNDARY_INSTANT,
  BERLIN_TIME_ZONE,
  berlinBusinessDate,
  installBundleCreatedAtOverride,
  offsetBusinessDate,
};
