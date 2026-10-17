/**
 * Local-only accounts for seeded development and tests. Production never runs
 * this: people are added on the Users page and sign in with SSO, and agents
 * use the device flow. No account here has a password; local sign-in goes
 * through the development portal broker (DATAOPS_DEV_ACTOR_EMAIL) or a test
 * session minted by the test server.
 */
import { getClient } from '../src/db/client';
import { createUserWithId, getUser } from '../src/db/users';

export const USERS = [
  { id: '00000000-0000-0000-0000-000000000001', name: 'Grace', email: 'grace@datatalks.club', role: 'admin' as const },
  { id: '00000000-0000-0000-0000-000000000002', name: 'Valeriia', email: 'valeriia@datatalks.club', role: 'admin' as const },
  { id: '00000000-0000-0000-0000-000000000003', name: 'Alexey', email: 'alexey@datatalks.club', role: 'admin' as const },
  // Orin is the operator agent: full execution rights, no administration.
  { id: '00000000-0000-0000-0000-000000000004', name: 'Orin', email: 'orin@datatalks.club', role: 'operator' as const },
] as const;

export const ALEXEY_USER_ID = USERS[2].id;

async function seed(): Promise<void> {
  const client = await getClient();
  for (const { id, ...data } of USERS) {
    if (!(await getUser(client, id))) await createUserWithId(client, id, data);
  }
}

if (require.main === module) {
  seed()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}

export { seed };
