import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import {
  type AuthoredTemplateDefinition,
  loadAuthoredTemplatesFromKnowledge,
  reconcileAuthoredTemplates,
} from './templates/authoredTemplates';

// A deploy projects only Git-authored definitions. Recurring schedules, Cards,
// Tasks and settings are user data managed in the portal; a deploy never
// creates, re-enables or rewrites them.
export interface DeploymentSeedReport {
  templates: {
    total: number;
    created: number;
    updated: number;
    unchanged: number;
  };
}

type AuthoredTemplateLoader = () => Promise<AuthoredTemplateDefinition[]>;
const canonicalDeploymentTemplateLoader: AuthoredTemplateLoader = loadAuthoredTemplatesFromKnowledge;
let deploymentTemplateLoader: AuthoredTemplateLoader = canonicalDeploymentTemplateLoader;

export function setDeploymentTemplateLoaderForTest(loader: AuthoredTemplateLoader | null): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Deployment template loader injection is test-only');
  }
  deploymentTemplateLoader = loader || canonicalDeploymentTemplateLoader;
}

export function assertCanonicalDeploymentTemplateLoader(): void {
  if (deploymentTemplateLoader !== canonicalDeploymentTemplateLoader) {
    throw new Error('Deployment template loader injection must not be active outside tests');
  }
}

export async function seedDeploymentRuntime(
  client: DynamoDBDocumentClient,
  loadTemplates: AuthoredTemplateLoader = deploymentTemplateLoader
): Promise<DeploymentSeedReport> {
  const templates = await reconcileAuthoredTemplates(client, await loadTemplates());
  return { templates };
}
