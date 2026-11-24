import { setOwnerCalendarProviderClientsForTests } from '../../src/calendar/ownerCalendarOverlay';
import { DAPIER_AGENT } from '../../src/calendar/dapierBroker';
import { OWNER_PERSONAL_CALENDAR } from '../../src/identity/operatingIdentities';
/** Protocol fixture for the owner account; event responses remain owned by each scenario. */
export function withOwnerAvailability(run: typeof fetch, discovery = true): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    if (discovery && url.endsWith('/api/agent/connections')) return Response.json({ connections: [{ connection_id: 'owner-calendar-test', provider: 'google', agent: DAPIER_AGENT, status: 'connected', operations: ['use'], verified_account_id: OWNER_PERSONAL_CALENDAR, granted_scopes: ['https://www.googleapis.com/auth/calendar'] }] });
    if (url.endsWith('/calendars/primary')) return Response.json({ id: OWNER_PERSONAL_CALENDAR });
    if (url.includes('/users/me/calendarList')) return Response.json({ items: [{ id: OWNER_PERSONAL_CALENDAR }] });
    if (url.endsWith('/freeBusy')) return Response.json({ calendars: { [OWNER_PERSONAL_CALENDAR]: { busy: [] } } });
    return run(input, init);
  };
}
export function installOwnerAvailabilityFixture() {
  setOwnerCalendarProviderClientsForTests({ readSecret: async () => 'synthetic', fetch: withOwnerAvailability(async input => Response.json(String(input).endsWith('/api/agent/token') ? { access_token: 'synthetic' } : { items: [] })) });
}
