import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import {
  getDocumentReview,
  listDocumentReviewHistory,
  listDocumentReviews,
  saveDocumentReview,
} from '../db/documentReviews';
import type {
  DocumentReviewCheck,
  DocumentReviewChecklist,
  DocumentReviewDecision,
  DocumentReviewRecord,
  LambdaEvent,
  LambdaResponse,
} from '../types';

const JSON_HEADERS: Record<string, string> = { 'Content-Type': 'application/json' };
const ROUTE_PREFIX = '/api/document-reviews';
const DOCUMENT_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const DOCUMENT_PATH_RE = /^content\/[a-zA-Z0-9][a-zA-Z0-9/_-]*\.md$/;
const DECISIONS = new Set<DocumentReviewDecision>([
  'approved',
  'changes_requested',
  'blocked',
  'deferred',
]);
const CHECKS = new Set<DocumentReviewCheck>([
  'unreviewed',
  'pass',
  'needs_work',
  'na',
]);
const CHECKLIST_FIELDS = [
  'purpose',
  'procedure',
  'validation',
  'troubleshooting',
  'references',
  'ownership',
] as const;
const UNSAFE_FEEDBACK = /(X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|signature=|sig=|access_token=|token=|api[_-]?key=|authorization:|bearer\s+\S+)/i;

class ReviewRequestError extends Error {}

function jsonResponse(statusCode: number, body: unknown): LambdaResponse {
  return {
    statusCode,
    headers: JSON_HEADERS,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

function parseBody(event: LambdaEvent): Record<string, unknown> | null {
  if (!event.body) return null;
  try {
    const parsed = JSON.parse(event.body);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function headerValue(headers: Record<string, string> | null | undefined, name: string): string {
  if (!headers) return '';
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return match ? String(match[1]) : '';
}

function documentIdFromPath(path: string): string | null | undefined {
  if (path === ROUTE_PREFIX) return null;
  if (!path.startsWith(`${ROUTE_PREFIX}/`)) return undefined;
  const raw = path.slice(`${ROUTE_PREFIX}/`.length);
  if (!raw || raw.includes('/')) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function requiredString(body: Record<string, unknown>, field: string, maxLength: number): string {
  const value = body[field];
  if (!isNonEmptyString(value)) throw new ReviewRequestError(`${field} is required`);
  const trimmed = value.trim();
  if (trimmed.length > maxLength) throw new ReviewRequestError(`${field} must be ${maxLength} characters or fewer`);
  return trimmed;
}

function validateDocumentId(value: string): string {
  if (!DOCUMENT_ID_RE.test(value)) throw new ReviewRequestError('documentId must be a stable document id');
  return value;
}

function validateDocumentPath(value: string): string {
  if (!DOCUMENT_PATH_RE.test(value)) throw new ReviewRequestError('documentPath must be a content Markdown path');
  return value;
}

function validateUpdatedAt(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new ReviewRequestError('documentUpdatedAt must be a non-negative integer');
  }
  return Number(value);
}

function validateChecklist(value: unknown): DocumentReviewChecklist {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ReviewRequestError('checklist is required and must be an object');
  }
  const input = value as Record<string, unknown>;
  const unknownField = Object.keys(input).find((field) => !CHECKLIST_FIELDS.includes(field as typeof CHECKLIST_FIELDS[number]));
  if (unknownField) throw new ReviewRequestError(`checklist contains unsupported field: ${unknownField}`);
  const checklist = {} as DocumentReviewChecklist;
  for (const field of CHECKLIST_FIELDS) {
    const check = input[field];
    if (typeof check !== 'string' || !CHECKS.has(check as DocumentReviewCheck)) {
      throw new ReviewRequestError(`checklist.${field} must be one of: ${Array.from(CHECKS).join(', ')}`);
    }
    checklist[field] = check as DocumentReviewCheck;
  }
  return checklist;
}

function validateFeedback(value: unknown, decision: DocumentReviewDecision): string {
  if (value !== undefined && typeof value !== 'string') throw new ReviewRequestError('feedback must be a string');
  const feedback = typeof value === 'string' ? value.trim() : '';
  if (feedback.length > 4000) throw new ReviewRequestError('feedback must be 4000 characters or fewer');
  if (UNSAFE_FEEDBACK.test(feedback)) throw new ReviewRequestError('feedback must not contain tokens, credentials, or signed URLs');
  if ((decision === 'changes_requested' || decision === 'blocked') && !feedback) {
    throw new ReviewRequestError(`${decision} decisions require feedback`);
  }
  return feedback;
}

function validateDecision(value: unknown): DocumentReviewDecision {
  if (typeof value !== 'string' || !DECISIONS.has(value as DocumentReviewDecision)) {
    throw new ReviewRequestError(`decision must be one of: ${Array.from(DECISIONS).join(', ')}`);
  }
  return value as DocumentReviewDecision;
}

function validateApprovedChecklist(checklist: DocumentReviewChecklist, decision: DocumentReviewDecision): void {
  if (decision !== 'approved') return;
  const incomplete = CHECKLIST_FIELDS.filter((field) => !['pass', 'na'].includes(checklist[field]));
  if (incomplete.length > 0) throw new ReviewRequestError(`approved decisions require pass or na for: ${incomplete.join(', ')}`);
}

function reviewFromBody(event: LambdaEvent): DocumentReviewRecord {
  const body = parseBody(event);
  if (!body) throw new ReviewRequestError('Request body must be a JSON object');
  const documentId = validateDocumentId(requiredString(body, 'documentId', 200));
  const documentPath = validateDocumentPath(requiredString(body, 'documentPath', 500));
  const decision = validateDecision(body.decision);
  const checklist = validateChecklist(body.checklist);
  validateApprovedChecklist(checklist, decision);
  const feedback = validateFeedback(body.feedback, decision);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const reviewerId = headerValue(event.headers, 'x-user-id') || 'local-operator';
  return {
    id,
    documentId,
    documentPath,
    documentUpdatedAt: validateUpdatedAt(body.documentUpdatedAt),
    decision,
    feedback,
    checklist,
    reviewerId,
    reviewedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

export async function handleDocumentReviewRoutes(
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse | null> {
  const path = event.path || '/';
  if (path !== ROUTE_PREFIX && !path.startsWith(`${ROUTE_PREFIX}/`)) return null;
  const method = (event.httpMethod || 'GET').toUpperCase();
  try {
    if (method === 'GET' && path === ROUTE_PREFIX) {
      return jsonResponse(200, { reviews: await listDocumentReviews(client) });
    }
    if (method === 'GET') {
      const documentId = documentIdFromPath(path);
      if (!documentId) return jsonResponse(404, { error: 'Document review not found' });
      validateDocumentId(documentId);
      const [review, history] = await Promise.all([
        getDocumentReview(client, documentId),
        listDocumentReviewHistory(client, documentId),
      ]);
      if (!review) return jsonResponse(404, { error: 'Document review not found' });
      return jsonResponse(200, { review, history });
    }
    if (method === 'POST' && path === ROUTE_PREFIX) {
      const review = reviewFromBody(event);
      await saveDocumentReview(client, review);
      return jsonResponse(201, { review });
    }
    return jsonResponse(405, { error: 'Method not allowed' });
  } catch (error) {
    if (error instanceof ReviewRequestError) return jsonResponse(400, { error: error.message });
    console.error('Document review API error:', error);
    return jsonResponse(500, { error: 'Internal server error' });
  }
}

