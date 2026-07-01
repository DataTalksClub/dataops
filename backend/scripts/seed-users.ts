import { getClient, startLocal } from '../src/db/client';
import { createTables } from '../src/db/setup';
import { listUsers, createUserWithId, getUserByEmail } from '../src/db/users';
import type { User } from '../src/types';

function shouldUseLocalDynamo(): boolean {
  return (
    process.env.IS_LOCAL === 'true' ||
    process.env.IS_LOCAL === '1' ||
    process.env.NODE_ENV === 'test' ||
    process.env.NODE_ENV === 'local' ||
    Boolean(process.env.DYNAMODB_ENDPOINT)
  );
}

/**
 * Simple SHA-256 hash using Web Crypto API.
 */
async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

const USERS = [
  { id: '00000000-0000-0000-0000-000000000001', name: 'Grace', email: 'grace@datatalks.club', role: 'admin' as const },
  { id: '00000000-0000-0000-0000-000000000002', name: 'Valeriia', email: 'valeriia@datatalks.club', role: 'admin' as const },
  { id: '00000000-0000-0000-0000-000000000003', name: 'Alexey', email: 'alexey@datatalks.club', role: 'admin' as const },
];

// Default password for all seeded users
const DEFAULT_PASSWORD = '111';

async function seed(): Promise<void> {
  const useLocalDynamo = shouldUseLocalDynamo();
  const port = useLocalDynamo && !process.env.DYNAMODB_ENDPOINT
    ? await startLocal()
    : undefined;
  const client = await getClient(port);

  if (useLocalDynamo) {
    await createTables(client);
  }

  // Hash the default password once
  const passwordHash = await hashPassword(DEFAULT_PASSWORD);

  // Create or update users with stable IDs and hashed password
  const created: User[] = [];
  for (const userData of USERS) {
    const { id, ...data } = userData;
    const existing = await getUserByEmail(client, data.email);

    if (existing) {
      // User exists - update if no passwordHash set
      if (!existing.passwordHash) {
        // Re-create with passwordHash (createUserWithId is upsert via PutCommand)
        const user = await createUserWithId(client, id, { ...data, passwordHash });
        created.push(user);
        console.log(`Updated user with password: ${user.name} (${user.email}) — id: ${user.id}`);
      } else {
        console.log(`User already has password: ${existing.name} (${existing.email})`);
        created.push(existing as User);
      }
    } else {
      const user = await createUserWithId(client, id, { ...data, passwordHash });
      created.push(user);
      console.log(`Created user: ${user.name} (${user.email}) — id: ${user.id}`);
    }
  }

  console.log(`\nSeed complete. Processed ${created.length} users.`);
}

// Run if executed directly
if (require.main === module) {
  seed()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}

export { seed, USERS };
