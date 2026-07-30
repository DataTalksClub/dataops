import { createHash } from 'crypto';

import type { JsonValue, PluginDraft, ProposalSpec } from './types';
import {
  TODO_ACTION,
  TODO_DATE_ONLY_CONFIRMATION,
  TODO_EFFECT,
  TODO_PERMISSION,
  TODO_PLUGIN_ID,
  TODO_POLICY_DIGEST,
  TODO_TIME_ZONE,
  todoMetadata,
  classifyTodoSource,
  validateTodoProposalInput,
  type TodoCandidate,
} from './todoPlugin';

interface ProposalAdapterContext {
  actorId: string;
  conversationId: string;
  draft: PluginDraft;
  permissionRevision: number;
  expiresAt: string;
}

type ProposalSourcePreflight =
  | { kind: 'ready'; proof: JsonValue }
  | { kind: 'clarification'; message: string; guard?: JsonValue };

interface ProposalPresentationCopy {
  message: string;
  approveLabel: string;
  requestChangesLabel: string;
  cancelLabel: string;
  discardLabel: string;
  changePrompt: string;
  canceledMessage: string;
  discardedMessage: string;
  pendingMessage: (attemptId: string) => string;
}

interface ProposalAdapter {
  readonly pluginId: string;
  readonly action: string;
  readonly permissionRef: string;
  readonly buildDigest: string;
  readonly schemaDigest: string;
  readonly policyDigest: string;
  isEnabled(): boolean;
  preflightSource(
    text: string,
    conversationRevision: number,
    existingDraft: PluginDraft | null
  ): ProposalSourcePreflight;
  draftData(candidate: JsonValue, proof: JsonValue): JsonValue;
  validateCandidate(value: unknown): JsonValue | null;
  draftId(conversationId: string, actorId: string): string;
  proposalId(draftId: string): string;
  buildSpec(candidate: JsonValue, context: ProposalAdapterContext): ProposalSpec;
  presentation(candidate: JsonValue): ProposalPresentationCopy;
}

class StaticProposalCoordinator {
  private readonly adapters = new Map<string, ProposalAdapter>();
  private readonly adaptersByPlugin = new Map<string, ProposalAdapter>();

  constructor(adapters: ProposalAdapter[]) {
    for (const adapter of adapters) {
      const key = this.key(adapter.pluginId, adapter.action);
      if (this.adapters.has(key)) throw new Error('Duplicate proposal adapter');
      if (this.adaptersByPlugin.has(adapter.pluginId)) {
        throw new Error('Each proposal plugin must have one coordinator adapter');
      }
      this.adapters.set(key, Object.freeze(adapter));
      this.adaptersByPlugin.set(adapter.pluginId, adapter);
    }
  }

  get(pluginId: string, action: string): ProposalAdapter | null {
    return this.adapters.get(this.key(pluginId, action)) || null;
  }

  getByPlugin(pluginId: string): ProposalAdapter | null {
    return this.adaptersByPlugin.get(pluginId) || null;
  }

  list(): ProposalAdapter[] {
    return [...this.adapters.values()];
  }

  private key(pluginId: string, action: string): string {
    return `${pluginId}\0${action}`;
  }
}

function stableId(prefix: string, value: string): string {
  return `${prefix}-${createHash('sha256').update(value).digest('hex')}`;
}

class TodoProposalAdapter implements ProposalAdapter {
  readonly pluginId = TODO_PLUGIN_ID;
  readonly action = TODO_ACTION;
  readonly permissionRef = TODO_PERMISSION;
  readonly buildDigest = todoMetadata.buildDigest;
  readonly schemaDigest = todoMetadata.schemaDigest;
  readonly policyDigest = TODO_POLICY_DIGEST;

  isEnabled(): boolean {
    return process.env.CONVERSATIONAL_TODO_PLUGIN_ENABLED === 'true'
      && process.env.CONVERSATIONAL_TODO_EXECUTOR_ENABLED === 'true';
  }

  preflightSource(
    text: string,
    conversationRevision: number,
    existingDraft: PluginDraft | null
  ): ProposalSourcePreflight {
    const sourceHash = `sha256:${createHash('sha256').update(text.normalize('NFKC')).digest('hex')}`;
    const existing = existingDraft?.data && typeof existingDraft.data === 'object'
      && !Array.isArray(existingDraft.data)
      ? existingDraft.data as Record<string, JsonValue>
      : null;
    if (text.trim().toLocaleLowerCase('en-US') === TODO_DATE_ONLY_CONFIRMATION) {
      if (
        existing?.kind === 'todo_date_only_guard'
        && existing.requiresDateOnlyConfirmation === true
        && typeof existing.sourceHash === 'string'
      ) {
        return {
          kind: 'ready',
          proof: {
            kind: 'todo_source_proof',
            oneTodo: true,
            dateOnlyConfirmed: true,
            sourceHash: existing.sourceHash,
            confirmationRevision: conversationRevision,
          },
        };
      }
      return {
        kind: 'clarification',
        message: 'There is no current date-only confirmation. Please restate the one todo and date.',
      };
    }
    const classification = classifyTodoSource(text);
    if (classification === 'requires_date_only_confirmation') {
      return {
        kind: 'clarification',
        message: `This version stores a date only and cannot keep a time or reminder. Reply exactly "${TODO_DATE_ONLY_CONFIRMATION}" to confirm the date-only todo.`,
        guard: {
          kind: 'todo_date_only_guard',
          requiresDateOnlyConfirmation: true,
          sourceHash,
          sourceRevision: conversationRevision,
        },
      };
    }
    if (classification === 'multiple') {
      return {
        kind: 'clarification',
        message: 'One proposal can contain only one todo. Which single task should I prepare?',
        guard: {
          kind: 'todo_multiple_request_blocked',
          sourceHash,
          sourceRevision: conversationRevision,
        },
      };
    }
    return {
      kind: 'ready',
      proof: {
        kind: 'todo_source_proof',
        oneTodo: true,
        dateOnlyConfirmed: false,
        sourceHash,
        sourceRevision: conversationRevision,
      },
    };
  }

  draftData(candidate: JsonValue, proof: JsonValue): JsonValue {
    return {
      kind: 'todo_candidate_with_source_proof',
      candidate,
      proof,
    };
  }

  validateCandidate(value: unknown): JsonValue | null {
    const result = validateTodoProposalInput(TODO_ACTION, value);
    return result.kind === 'proposal_candidate' ? result.value as JsonValue : null;
  }

  draftId(conversationId: string, actorId: string): string {
    return stableId('todo-draft', `${conversationId}:${actorId}`);
  }

  proposalId(draftId: string): string {
    return stableId('todo-proposal', draftId);
  }

  buildSpec(candidateValue: JsonValue, context: ProposalAdapterContext): ProposalSpec {
    const candidate = candidateValue as unknown as TodoCandidate;
    const draftData = context.draft.data && typeof context.draft.data === 'object'
      && !Array.isArray(context.draft.data)
      ? context.draft.data as Record<string, JsonValue>
      : null;
    const proof = draftData?.proof && typeof draftData.proof === 'object'
      && !Array.isArray(draftData.proof)
      ? draftData.proof as Record<string, JsonValue>
      : null;
    if (
      draftData?.kind !== 'todo_candidate_with_source_proof'
      || proof?.kind !== 'todo_source_proof'
      || proof.oneTodo !== true
      || typeof proof.dateOnlyConfirmed !== 'boolean'
      || typeof proof.sourceHash !== 'string'
      || !/^sha256:[a-f0-9]{64}$/.test(proof.sourceHash)
    ) throw new Error('Todo source proof is unavailable');
    return {
      pluginId: TODO_PLUGIN_ID,
      pluginBuildDigest: todoMetadata.buildDigest,
      schemaDigest: todoMetadata.schemaDigest,
      policyDigest: TODO_POLICY_DIGEST,
      action: TODO_ACTION,
      operation: 'create',
      effect: TODO_EFFECT,
      destinationRef: 'dataops.tasks',
      proposedContent: {
        description: candidate.description,
        date: candidate.date,
        status: 'todo',
        source: 'conversational-agent',
        timeZone: TODO_TIME_ZONE,
        actorId: context.actorId,
        ownerId: context.actorId,
        assigneeId: context.actorId,
      },
      sourceRefs: [{
        ref: `plugin-draft:${context.draft.id}`,
        revision: String(context.draft.revision),
        classification: 'private',
      }, {
        ref: `todo-source-proof:${proof.sourceHash}`,
        revision: proof.dateOnlyConfirmed === true ? 'date-only-confirmed' : 'no-time-requested',
        classification: 'internal',
      }],
      permissionRef: TODO_PERMISSION,
      permissionRevision: context.permissionRevision,
      expiresAt: context.expiresAt,
    };
  }

  presentation(candidateValue: JsonValue): ProposalPresentationCopy {
    const candidate = candidateValue as unknown as TodoCandidate;
    return {
      message: [
        'Todo',
        `Task: ${candidate.description}`,
        `Date: ${candidate.date} (${TODO_TIME_ZONE}, date only)`,
        'Assignee: You',
        'Status: Todo',
      ].join('\n'),
      approveLabel: 'Approve todo',
      requestChangesLabel: 'Request changes',
      cancelLabel: 'Cancel proposal',
      discardLabel: 'Discard draft',
      changePrompt: 'What should I change in the task or date?',
      canceledMessage: 'Todo proposal canceled. The draft is still available.',
      discardedMessage: 'Todo draft discarded.',
      pendingMessage: (attemptId) => `Todo approved and queued safely. Execution ID: ${attemptId}`,
    };
  }
}

const todoProposalAdapter = new TodoProposalAdapter();
const productionProposalCoordinator = new StaticProposalCoordinator([todoProposalAdapter]);

export {
  StaticProposalCoordinator,
  TodoProposalAdapter,
  productionProposalCoordinator,
  todoProposalAdapter,
};
export type {
  ProposalAdapter,
  ProposalAdapterContext,
  ProposalPresentationCopy,
  ProposalSourcePreflight,
};
