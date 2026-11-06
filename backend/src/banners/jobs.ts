import { GetCommand, PutCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TABLE_ARTIFACTS } from '../db/tableNames';
import type { BannerJob } from './model';
const key = (id: string) => ({ PK: `BANNERJOB#${id}`, SK: `BANNERJOB#${id}` });
export async function getBannerJob(client: DynamoDBDocumentClient, id: string): Promise<BannerJob | null> {
  const result = await client.send(new GetCommand({ TableName: TABLE_ARTIFACTS, Key: key(id), ConsistentRead: true }));
  if (!result.Item) return null;
  const { PK: _pk, SK: _sk, ...job } = result.Item;
  return job as BannerJob;
}
export async function putBannerJob(client: DynamoDBDocumentClient, job: BannerJob): Promise<BannerJob> {
  try { await client.send(new PutCommand({ TableName: TABLE_ARTIFACTS, Item: { ...key(job.id), ...job }, ConditionExpression: 'attribute_not_exists(PK)' })); return job; }
  catch (error) { if ((error as Error).name !== 'ConditionalCheckFailedException') throw error; return (await getBannerJob(client, job.id))!; }
}
export async function transitionBannerJob(client: DynamoDBDocumentClient, job: BannerJob, state: BannerJob['state'], extra: Record<string, unknown> = {}): Promise<boolean> {
  const fields = { state, updatedAt: new Date().toISOString(), ...extra };
  const names: Record<string, string> = { '#previous': 'state' };
  const values: Record<string, unknown> = { ':previous': job.state };
  const sets = Object.entries(fields).map(([name, value], i) => { names[`#n${i}`] = name; values[`:v${i}`] = value; return `#n${i} = :v${i}`; });
  // A worker may recover an expired lease after Lambda/SQS delivery interruption.
  const condition = job.state === 'rendering' ? '#previous = :previous AND leaseUntil = :lease' : '#previous = :previous';
  if (job.state === 'rendering') values[':lease'] = job.leaseUntil;
  try { await client.send(new UpdateCommand({ TableName: TABLE_ARTIFACTS, Key: key(job.id), UpdateExpression: `SET ${sets.join(', ')}`, ConditionExpression: condition, ExpressionAttributeNames: names, ExpressionAttributeValues: values })); return true; }
  catch (error) { if ((error as Error).name === 'ConditionalCheckFailedException') return false; throw error; }
}
