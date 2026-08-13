import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/**
 * Get a DynamoDB Document Client.
 *
 * Priority:
 * 1. If DYNAMODB_ENDPOINT is set, connect to that explicit local endpoint.
 * 2. If a local port is supplied by script/test tooling, connect to it.
 * 3. Otherwise, use default AWS SDK config (production).
 *
 * Starting a database and creating its tables are deliberately absent here.
 * Local callers must opt into the setup entry point under scripts/.
 */
async function getClient(localPort?: number): Promise<DynamoDBDocumentClient> {
  const endpoint = process.env.DYNAMODB_ENDPOINT
    || (localPort === undefined ? '' : `http://127.0.0.1:${localPort}`);
  if (endpoint) {
    const raw = new DynamoDBClient({
      region: process.env.AWS_REGION || 'us-east-1',
      endpoint,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'local',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'local',
      },
    });
    return failLoudlyOnMissingTable(DynamoDBDocumentClient.from(raw));
  }

  // Otherwise, use default AWS SDK config
  const raw = new DynamoDBClient({});
  return failLoudlyOnMissingTable(DynamoDBDocumentClient.from(raw));
}

/**
 * Tables are created by infrastructure, never by this application. If one is
 * missing the deployment is wrong, so say so plainly instead of surfacing a
 * bare ResourceNotFoundException from whichever request happened to touch it
 * first. The function has no dynamodb:DescribeTable permission by design, so
 * this is detected on use rather than probed at startup.
 */
function failLoudlyOnMissingTable(client: DynamoDBDocumentClient): DynamoDBDocumentClient {
  const send = client.send.bind(client) as (...args: unknown[]) => Promise<unknown>;
  (client as unknown as { send: unknown }).send = async (...args: unknown[]) => {
    try {
      return await send(...args);
    } catch (error) {
      const err = error as { name?: string; message?: string };
      if (err?.name !== 'ResourceNotFoundException') throw error;
      const command = args[0] as { input?: { TableName?: string } } | undefined;
      const table = command?.input?.TableName;
      // Augment in place rather than replacing the error: callers may branch
      // on error.name === 'ResourceNotFoundException', and a new Error would
      // silently break them.
      err.message = `DynamoDB table ${table ? `'${table}' ` : ''}does not exist. `
        + 'Tables are defined in infrastructure and are never created by the application. '
        + 'Deploy the stack, or for local development run the local setup script. '
        + `(${err.message})`;
      throw error;
    }
  };
  return client;
}

export { getClient, failLoudlyOnMissingTable };
