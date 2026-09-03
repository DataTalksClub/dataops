import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { handleDocumentReviewRoutes } from '../src/routes/documentReviews';
import type { DocumentReviewChecklist, LambdaEvent } from '../src/types';
import { truncateTestTables, useTestDatabase } from './helpers/db';

const checklist: DocumentReviewChecklist = {
  purpose: 'pass',
  procedure: 'pass',
  validation: 'pass',
  troubleshooting: 'pass',
  references: 'na',
  ownership: 'pass',
};

function event(
  httpMethod: string,
  path: string,
  body?: Record<string, unknown>,
): LambdaEvent {
  return {
    httpMethod,
    path,
    headers: { 'x-user-id': 'reviewer-1' },
    body: body ? JSON.stringify(body) : null,
  };
}

describe('document review API', () => {
  let client: Awaited<ReturnType<typeof useTestDatabase>>['client'];

  beforeEach(async () => {
    ({ client } = await useTestDatabase());
    await truncateTestTables(client);
  });

  it('persists a current decision and append-only history', async () => {
    const create = await handleDocumentReviewRoutes(
      event('POST', '/api/document-reviews', {
        documentId: 'sop.operations.publish-newsletter',
        documentPath: 'content/07-internal-operations/publish-newsletter/sops/run.md',
        documentUpdatedAt: 1725000000,
        decision: 'approved',
        checklist,
      }),
      client,
    );
    assert.equal(create?.statusCode, 201);
    const created = JSON.parse(create!.body).review;
    assert.equal(created.reviewerId, 'reviewer-1');
    assert.equal(created.feedback, '');

    const list = await handleDocumentReviewRoutes(
      event('GET', '/api/document-reviews'),
      client,
    );
    assert.equal(list?.statusCode, 200);
    assert.equal(JSON.parse(list!.body).reviews.length, 1);

    const detail = await handleDocumentReviewRoutes(
      event('GET', `/api/document-reviews/${encodeURIComponent(created.documentId)}`),
      client,
    );
    assert.equal(detail?.statusCode, 200);
    const detailBody = JSON.parse(detail!.body);
    assert.equal(detailBody.review.id, created.id);
    assert.equal(detailBody.history.length, 1);
    assert.equal(detailBody.history[0].decision, 'approved');

    const revised = await handleDocumentReviewRoutes(
      event('POST', '/api/document-reviews', {
        documentId: created.documentId,
        documentPath: created.documentPath,
        documentUpdatedAt: 1725000001,
        decision: 'changes_requested',
        checklist: { ...checklist, validation: 'needs_work' },
        feedback: 'Add an observable validation result.',
      }),
      client,
    );
    assert.equal(revised?.statusCode, 201);

    const revisedDetail = await handleDocumentReviewRoutes(
      event('GET', `/api/document-reviews/${encodeURIComponent(created.documentId)}`),
      client,
    );
    const revisedBody = JSON.parse(revisedDetail!.body);
    assert.equal(revisedBody.review.decision, 'changes_requested');
    assert.equal(revisedBody.history.length, 2);
    assert.equal(revisedBody.history[0].feedback, 'Add an observable validation result.');
  });

  it('requires actionable feedback and rejects unsafe review content', async () => {
    const missingFeedback = await handleDocumentReviewRoutes(
      event('POST', '/api/document-reviews', {
        documentId: 'sop.example',
        documentPath: 'content/example/sops/example.md',
        documentUpdatedAt: 1,
        decision: 'blocked',
        checklist,
      }),
      client,
    );
    assert.equal(missingFeedback?.statusCode, 400);
    assert.match(missingFeedback!.body, /require feedback/);

    const unsafe = await handleDocumentReviewRoutes(
      event('POST', '/api/document-reviews', {
        documentId: 'sop.example',
        documentPath: 'content/example/sops/example.md',
        documentUpdatedAt: 1,
        decision: 'changes_requested',
        checklist: { ...checklist, validation: 'needs_work' },
        feedback: 'token=do-not-store-this',
      }),
      client,
    );
    assert.equal(unsafe?.statusCode, 400);
    assert.match(unsafe!.body, /must not contain tokens/);
  });

  it('does not expose a missing review as an empty success', async () => {
    const response = await handleDocumentReviewRoutes(
      event('GET', '/api/document-reviews/sop.missing'),
      client,
    );
    assert.equal(response?.statusCode, 404);
  });

  it('requires a verified interactive actor when the test bypass is disabled', async () => {
    const previous = process.env.SKIP_AUTH;
    process.env.SKIP_AUTH = 'false';
    try {
      const response = await handleDocumentReviewRoutes(
        event('GET', '/api/document-reviews'),
        client,
      );
      assert.equal(response?.statusCode, 401);
    } finally {
      if (previous === undefined) delete process.env.SKIP_AUTH;
      else process.env.SKIP_AUTH = previous;
    }
  });
});
