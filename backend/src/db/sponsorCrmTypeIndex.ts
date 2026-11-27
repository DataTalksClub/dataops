import { AsyncLocalStorage } from 'node:async_hooks';
import { TABLE_SPONSOR_CRM } from './tableNames';

/**
 * The sponsor CRM table keys every record as `<TYPE>#<id>`, so a type has no
 * partition of its own and listing one used to Scan the whole table, paying
 * for messages, communications and history rows only to discard them.
 *
 * GSI-EntityType partitions the listable record types by `GSI5PK` (the type,
 * e.g. `DEAL`) with `PK` as the sort key, so listing deals is a Query that
 * reads deals only. The index is sparse: only the types below carry GSI5PK,
 * so high-volume rows (messages, history, communications) cost no index
 * writes or storage.
 */
export const ENTITY_TYPE_INDEX = 'GSI-EntityType';
export const ENTITY_TYPE_ATTRIBUTE = 'GSI5PK';

export const INDEXED_ENTITY_TYPES = [
  'ORGANIZATION', 'CONTACT', 'DEAL', 'DELIVERABLE', 'LEAD', 'NEWSLETTER',
  'NEWSLETTER-ISSUE', 'CONTRACT', 'PAYMENT_MAIL', 'SPONSOR_FINANCE',
  'SPONSOR_FINANCE_PAYMENT', 'SPONSOR_INVOICE_TASK', 'VIES-CHECK',
] as const;
const INDEXED = new Set<string>(INDEXED_ENTITY_TYPES);

/** The indexed type a row belongs to, from its PK, or undefined when unindexed. */
export function entityTypeOf(pk: unknown): string | undefined {
  if (typeof pk !== 'string') return undefined;
  const separator = pk.indexOf('#');
  if (separator < 1) return undefined;
  const type = pk.slice(0, separator);
  return INDEXED.has(type) ? type : undefined;
}

/** The indexed type a list prefix (`DEAL#`) names. Fails loudly otherwise. */
export function entityTypeOfPrefix(prefix: string): string {
  const type = prefix.endsWith('#') ? entityTypeOf(prefix) : undefined;
  if (!type || `${type}#` !== prefix) {
    throw new Error(`Sponsor CRM prefix '${prefix}' is not an indexed entity type; add it to INDEXED_ENTITY_TYPES and backfill`);
  }
  return type;
}

/** `item` with its index attribute derived from PK (a copy; never mutates). */
export function withEntityType<T extends Record<string, unknown>>(item: T): T {
  const type = entityTypeOf(item.PK);
  if (!type || item[ENTITY_TYPE_ATTRIBUTE] === type) return item;
  return { ...item, [ENTITY_TYPE_ATTRIBUTE]: type };
}

type Command = { constructor: { name: string }; input?: Record<string, any> };

/**
 * Stamp GSI5PK on every whole-item write to the sponsor CRM table. Done once at
 * the storage client so no writer (CRM, finance, contracts, leads, VIES, …)
 * can forget it. Updates never create these rows (they are guarded by
 * attribute_exists or a version check), so they keep the stamp the Put set.
 * Returns the indexed types the command writes, for read-snapshot invalidation.
 */
export function stampSponsorCrmWrite(command: Command): string[] {
  const input = command.input;
  if (!input) return [];
  const written: string[] = [];
  const stamp = (item: Record<string, unknown>) => {
    const type = entityTypeOf(item.PK);
    if (type) written.push(type);
    return withEntityType(item);
  };
  const keyType = (key: Record<string, unknown> | undefined) => {
    const type = entityTypeOf(key?.PK);
    if (type) written.push(type);
  };
  switch (command.constructor.name) {
    case 'PutCommand':
      if (input.TableName === TABLE_SPONSOR_CRM && input.Item) input.Item = stamp(input.Item);
      break;
    case 'UpdateCommand':
    case 'DeleteCommand':
      if (input.TableName === TABLE_SPONSOR_CRM) keyType(input.Key);
      break;
    case 'TransactWriteCommand':
      input.TransactItems = (input.TransactItems || []).map((operation: Record<string, any>) => {
        if (operation.Put?.TableName === TABLE_SPONSOR_CRM) {
          return { ...operation, Put: { ...operation.Put, Item: stamp(operation.Put.Item) } };
        }
        for (const kind of ['Update', 'Delete'] as const) {
          if (operation[kind]?.TableName === TABLE_SPONSOR_CRM) keyType(operation[kind].Key);
        }
        return operation;
      });
      break;
    case 'BatchWriteCommand': {
      const requests = input.RequestItems?.[TABLE_SPONSOR_CRM];
      if (Array.isArray(requests)) {
        input.RequestItems = {
          ...input.RequestItems,
          [TABLE_SPONSOR_CRM]: requests.map((request: Record<string, any>) => {
            if (request.PutRequest?.Item) return { PutRequest: { Item: stamp(request.PutRequest.Item) } };
            keyType(request.DeleteRequest?.Key);
            return request;
          }),
        };
      }
      break;
    }
    default:
      break;
  }
  return written;
}

// One invocation (an API request, a cron run) often lists the same types
// several times: a page load fans out into several list routes, and cron
// evaluators each read deals and organizations. Inside a snapshot scope each
// type is queried once and served from memory after that. Every write to an
// indexed type drops that type's memo (the storage client calls
// invalidateCrmReadSnapshot), so a read after a write in the same scope
// queries again instead of serving the pre-write list.
type CrmReadSnapshot = { byType: Map<string, Promise<Record<string, unknown>[]>> };
const readSnapshot = new AsyncLocalStorage<CrmReadSnapshot>();

/** Memoize sponsor CRM type lists for the duration of `operation`. */
export function withCrmReadSnapshot<T>(operation: () => Promise<T>): Promise<T> {
  if (readSnapshot.getStore()) return operation();
  return readSnapshot.run({ byType: new Map() }, operation);
}

/** The memoized list of `type` in this scope, loading it with `load` once. */
export function memoizedCrmType(type: string, load: () => Promise<Record<string, unknown>[]>) {
  const snapshot = readSnapshot.getStore();
  if (!snapshot) return load();
  let items = snapshot.byType.get(type);
  if (!items) {
    const loading = load();
    items = loading;
    snapshot.byType.set(type, loading);
    // A failed read must not poison later reads in the same scope.
    loading.catch(() => { if (snapshot.byType.get(type) === loading) snapshot.byType.delete(type); });
  }
  return items;
}

export function invalidateCrmReadSnapshot(types: readonly string[]) {
  const snapshot = readSnapshot.getStore();
  if (!snapshot) return;
  for (const type of types) snapshot.byType.delete(type);
}
