import { validateConversationalRecord, type ExecutionAttempt } from './types';

type AttemptStatus = ExecutionAttempt['status'];

function clean<T>(item: Record<string, unknown> | undefined): T | null {
  if (!item) return null;
  const {
    PK: _pk, SK: _sk, GSI1PK: _gsi1pk, GSI1SK: _gsi1sk,
    GSI2PK: _gsi2pk, GSI2SK: _gsi2sk, conversationRelationshipPK: _relationship,
    ...record
  } = item;
  return record as T;
}

function versionSk(version: number): string {
  return `VERSION#${String(version).padStart(12, '0')}`;
}

function recoverySortKey(attempt: ExecutionAttempt): string {
  return `READY#${attempt.readyAt}#LEASE#${attempt.leaseExpiresAt || '-'}#${attempt.id}`;
}

function attemptItem(attempt: ExecutionAttempt): Record<string, unknown> {
  validateConversationalRecord(attempt);
  return {
    ...attempt,
    PK: `ATTEMPT#${attempt.id}`,
    SK: 'META',
    GSI1PK: `PROPOSAL#${attempt.proposalId}#${attempt.proposalVersion}`,
    GSI1SK: `ATTEMPT#${String(attempt.attemptNumber).padStart(8, '0')}#${attempt.id}`,
    GSI2PK: `ATTEMPT_STATE#${attempt.status}`,
    GSI2SK: recoverySortKey(attempt),
    conversationRelationshipPK: `CONVERSATION#${attempt.conversationId}`,
  };
}

export type { AttemptStatus };
export {
  attemptItem,
  clean,
  recoverySortKey,
  versionSk,
};
