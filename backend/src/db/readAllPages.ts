import type { DynamoDBDocumentClient, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

const MAX_READ_PAGES = 200;

/**
 * Read every page of a Query or Scan. DynamoDB ends each page at 1 MB, and a
 * Scan's FilterExpression is applied after that limit, so a single request
 * silently returns a truncated (or empty) result once the table outgrows one
 * page. Bounded so a runaway read fails loudly instead of looping.
 */
export async function readAllPages(
  client: DynamoDBDocumentClient,
  command: (exclusiveStartKey: Record<string, unknown> | undefined) => QueryCommand | ScanCommand,
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  let pages = 0;
  do {
    const result = await client.send(command(exclusiveStartKey));
    items.push(...((result.Items || []) as Record<string, unknown>[]));
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    pages += 1;
    if (pages >= MAX_READ_PAGES && exclusiveStartKey) {
      throw new Error('DynamoDB read exceeded its bounded page limit');
    }
  } while (exclusiveStartKey);
  return items;
}
