import { createHash } from 'crypto';

import {
  canonicalJson,
  generateRegistryMetadata,
  type CompiledPluginArtifact,
  type PluginDefinition,
  type PluginResult,
} from './pluginRegistry';

const TYPEFULLY_PLUGIN_ID = 'typefully';
const TYPEFULLY_ACTION = 'propose_draft';
const TYPEFULLY_PERMISSION = 'typefully:create-saved-draft';
const TYPEFULLY_EFFECT = 'typefully.saved_draft.create';
const TYPEFULLY_OPERATION = 'create';
const TYPEFULLY_DELIVERY_MODE = 'operator_reconciliation_only';
const TYPEFULLY_ARTIFACT_ID = 'builtin/conversation/typefully-create-v1';
const TYPEFULLY_PUBLIC_CONFIRMATION = 'use this typed text as public source';
const TYPEFULLY_ACCOUNT_KEYS = ['alexey', 'datatalksclub'] as const;
const TYPEFULLY_PLATFORM_KEYS = ['x', 'linkedin'] as const;
const TYPEFULLY_RESOURCE_KEYS = [
  'typefully:account:alexey',
  'typefully:account:datatalksclub',
] as const;
const TYPEFULLY_POLICY = [
  'typefully-create-saved-draft-v1',
  'typed owner-confirmed public source only',
  'one logical account and one saved draft',
  'unscheduled unpublished unshared',
  'operator reconciliation only',
  'exact non-lossy preview and execution',
].join('\n');
const TYPEFULLY_POLICY_DIGEST = hash(TYPEFULLY_POLICY);
const TYPEFULLY_DELIVERY_MODE_DIGEST = hash(TYPEFULLY_DELIVERY_MODE);

type TypefullyAccount = typeof TYPEFULLY_ACCOUNT_KEYS[number];
type TypefullyPlatform = typeof TYPEFULLY_PLATFORM_KEYS[number];

interface TypefullyCandidate {
  account: TypefullyAccount;
  platforms: TypefullyPlatform[];
  xPosts?: string[];
  linkedinPosts?: string[];
  draftTitle?: string;
  scratchpadText?: string;
}

const CONTROL_OR_DIRECTIONAL = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;
const FORBIDDEN_SEMANTIC_KEY = /(?:publish|schedule|preferred.?time|next.?free.?slot|share|media|tag|comment|analytic|webhook|update|delete|target|draft.?id|social.?set|provider|url|base.?revision)/i;
const SOCIAL_INTENT = /\b(?:typefully|social(?:\s+media)?|linkedin|(?:x|twitter)\s+(?:post|thread)|post\s+(?:on|to|for)\s+(?:x|twitter|linkedin))\b/iu;
const SAFE_DRAFT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/;

function hash(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function codePoints(value: string): number {
  return [...value].length;
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function safeTypefullyDraftId(value: unknown): string | null {
  const draftId = typeof value === 'string' || (
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0
  ) ? String(value) : '';
  return SAFE_DRAFT_ID.test(draftId)
    && !/(?:token|secret|credential|api[_-]?key|authorization|bearer|^sk-)/i.test(draftId)
    ? draftId
    : null;
}

function safeTypefullyEditUrl(value: unknown): string | null {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 2_000) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLocaleLowerCase('en-US');
    if (
      url.protocol !== 'https:'
      || host !== 'typefully.com'
      || url.port
      || url.username
      || url.password
      || url.hash
      || /(?:token|secret|credential|authorization|api[_-]?key|bearer)/i.test(url.pathname)
      || [...url.searchParams].length > 3
      || [...url.searchParams].some(
        ([key, child]) => !['d', 'draft', 'id'].includes(key) || !safeTypefullyDraftId(child)
      )
    ) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function normalizedText(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string' || !isWellFormedUnicode(value)) return null;
  let normalized: string;
  try {
    normalized = value.normalize('NFKC').trim();
  } catch {
    return null;
  }
  if (!normalized || CONTROL_OR_DIRECTIONAL.test(normalized) || codePoints(normalized) > maximum) {
    return null;
  }
  return normalized;
}

function exactTextArray(
  value: unknown,
  minimum: number,
  maximum: number,
  itemMaximum: number
): string[] | null {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) return null;
  const normalized = value.map((item) => normalizedText(item, itemMaximum));
  if (normalized.some((item) => item === null)) return null;
  const posts = normalized as string[];
  if (new Set(posts).size !== posts.length) return null;
  return posts;
}

function recursivelyForbidden(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(recursivelyForbidden);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value as Record<string, unknown>).some(
    ([key, child]) => FORBIDDEN_SEMANTIC_KEY.test(key) || recursivelyForbidden(child)
  );
}

function validateTypefullyCandidate(input: unknown): TypefullyCandidate | null {
  if (!input || typeof input !== 'object' || Array.isArray(input) || recursivelyForbidden(input)) {
    return null;
  }
  const value = input as Record<string, unknown>;
  const allowed = new Set([
    'account', 'platforms', 'xPosts', 'linkedinPosts', 'draftTitle', 'scratchpadText',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return null;
  if (!TYPEFULLY_ACCOUNT_KEYS.includes(value.account as TypefullyAccount)) return null;
  if (
    !Array.isArray(value.platforms)
    || value.platforms.length < 1
    || value.platforms.length > 2
    || value.platforms.some((platform) => !TYPEFULLY_PLATFORM_KEYS.includes(platform as TypefullyPlatform))
    || new Set(value.platforms).size !== value.platforms.length
  ) return null;
  const platforms = value.platforms as TypefullyPlatform[];
  const hasX = platforms.includes('x');
  const hasLinkedin = platforms.includes('linkedin');
  const xPosts = value.xPosts === undefined ? undefined : exactTextArray(value.xPosts, 1, 25, 4_000);
  const linkedinPosts = value.linkedinPosts === undefined
    ? undefined
    : exactTextArray(value.linkedinPosts, 1, 1, 8_000);
  if ((hasX && !xPosts) || (!hasX && value.xPosts !== undefined)) return null;
  if ((hasLinkedin && !linkedinPosts) || (!hasLinkedin && value.linkedinPosts !== undefined)) return null;
  const draftTitle = value.draftTitle === undefined ? undefined : normalizedText(value.draftTitle, 120);
  const scratchpadText = value.scratchpadText === undefined
    ? undefined
    : normalizedText(value.scratchpadText, 1_000);
  if (value.draftTitle !== undefined && !draftTitle) return null;
  if (value.scratchpadText !== undefined && !scratchpadText) return null;
  const candidate: TypefullyCandidate = {
    account: value.account as TypefullyAccount,
    platforms,
    ...(xPosts ? { xPosts } : {}),
    ...(linkedinPosts ? { linkedinPosts } : {}),
    ...(draftTitle ? { draftTitle } : {}),
    ...(scratchpadText ? { scratchpadText } : {}),
  };
  if (Buffer.byteLength(canonicalJson(candidate), 'utf8') > 65_536) return null;
  return candidate;
}

function validateTypefullyProposalInput(action: string, input: unknown): PluginResult {
  if (action !== TYPEFULLY_ACTION) {
    return { kind: 'clarification', message: 'I can only prepare one new saved Typefully draft.' };
  }
  const candidate = validateTypefullyCandidate(input);
  if (!candidate) {
    return {
      kind: 'clarification',
      message: 'Please provide one account, one or both platforms, and complete bounded post copy.',
    };
  }
  return { kind: 'proposal_candidate', value: candidate };
}

function renderTypefullyCandidate(action: string, input: unknown): unknown {
  if (action !== TYPEFULLY_ACTION) throw new Error('Typefully action is unavailable');
  const candidate = validateTypefullyCandidate(input);
  if (!candidate) throw new Error('Typefully candidate is incomplete');
  return candidate;
}

const TYPEFULLY_INPUT_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false as const,
  required: ['account', 'platforms'],
  minProperties: 2,
  maxProperties: 6,
  properties: {
    account: { type: 'string', enum: [...TYPEFULLY_ACCOUNT_KEYS] },
    platforms: {
      type: 'array', minItems: 1, maxItems: 2, uniqueItems: true,
      items: { type: 'string', enum: [...TYPEFULLY_PLATFORM_KEYS] },
    },
    xPosts: {
      type: 'array', minItems: 1, maxItems: 25, uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 4_000 },
    },
    linkedinPosts: {
      type: 'array', minItems: 1, maxItems: 1, uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 8_000 },
    },
    draftTitle: { type: 'string', minLength: 1, maxLength: 120 },
    scratchpadText: { type: 'string', minLength: 1, maxLength: 1_000 },
  },
};

const TYPEFULLY_COMPILED_MODULE = [
  'typefully-create-v1',
  CONTROL_OR_DIRECTIONAL.source,
  FORBIDDEN_SEMANTIC_KEY.source,
  validateTypefullyCandidate.toString(),
  validateTypefullyProposalInput.toString(),
  renderTypefullyCandidate.toString(),
].join('\n');

const manifestWithoutDigests: Omit<PluginDefinition, 'buildDigest' | 'schemaDigest'> = {
  id: TYPEFULLY_PLUGIN_ID,
  version: 'v1',
  displayName: 'Typefully',
  summary: 'Prepare one unscheduled, unpublished, unshared saved Typefully draft.',
  activationHints: ['social post', 'Typefully draft', 'X thread', 'LinkedIn post'],
  skillInstructions: [
    'Prepare exactly one new saved draft and never claim it was created.',
    'Use only the confirmed typed public source supplied in this turn.',
    'Never include sourceRefs, classification, numeric account IDs, URLs, scheduling, publishing, sharing, media, tags, or an existing draft.',
    'Choose account only from alexey or datatalksclub and platforms only from x or linkedin.',
    'For X return one to 25 complete ordered posts. For LinkedIn return exactly one complete post.',
    'Do not truncate, summarize, reorder, merge, or drop requested copy.',
    'Ask one concise question when account, platforms, purpose, or source is ambiguous. Never ask for publication time.',
  ].join(' '),
  actions: [{
    name: TYPEFULLY_ACTION,
    description: 'Validate and prepare one create-only Typefully saved-draft proposal.',
    inputSchema: TYPEFULLY_INPUT_SCHEMA,
    effect: 'proposal',
    corePermission: TYPEFULLY_PERMISSION,
    externalEffect: true,
    reconciliationMode: TYPEFULLY_DELIVERY_MODE,
    executorDeclaration: 'TypefullySavedDraftExecutor.v1',
    reconcilerDeclaration: 'OperatorReconciliationOnly.v1',
  }],
  validator: validateTypefullyProposalInput,
  validatorDeclaration: 'validateTypefullyProposalInput.v1',
  proposalRenderer: renderTypefullyCandidate,
  proposalRendererDeclaration: 'renderTypefullyCandidate.v1',
  enabled: false,
  roles: ['admin', 'operator'],
  channels: ['telegram'],
  buildArtifactId: TYPEFULLY_ARTIFACT_ID,
};

const typefullyMetadata = generateRegistryMetadata(manifestWithoutDigests, TYPEFULLY_COMPILED_MODULE);
const typefullyPluginDefinition: PluginDefinition = { ...manifestWithoutDigests, ...typefullyMetadata };

function loadTypefullyPluginArtifact(buildArtifactId: string): CompiledPluginArtifact {
  if (buildArtifactId !== TYPEFULLY_ARTIFACT_ID) throw new Error('Unknown plugin artifact');
  return {
    compiledModule: TYPEFULLY_COMPILED_MODULE,
    validator: validateTypefullyProposalInput,
    proposalRenderer: renderTypefullyCandidate,
  };
}

function isTypefullyIntent(text: string): boolean {
  return SOCIAL_INTENT.test(text.normalize('NFKC'));
}

function typefullyResourceKey(account: TypefullyAccount): typeof TYPEFULLY_RESOURCE_KEYS[number] {
  return `typefully:account:${account}`;
}

export {
  CONTROL_OR_DIRECTIONAL,
  TYPEFULLY_ACCOUNT_KEYS,
  TYPEFULLY_ACTION,
  TYPEFULLY_ARTIFACT_ID,
  TYPEFULLY_DELIVERY_MODE,
  TYPEFULLY_DELIVERY_MODE_DIGEST,
  TYPEFULLY_EFFECT,
  TYPEFULLY_INPUT_SCHEMA,
  TYPEFULLY_OPERATION,
  TYPEFULLY_PERMISSION,
  TYPEFULLY_PLATFORM_KEYS,
  TYPEFULLY_PLUGIN_ID,
  TYPEFULLY_POLICY_DIGEST,
  TYPEFULLY_PUBLIC_CONFIRMATION,
  TYPEFULLY_RESOURCE_KEYS,
  isTypefullyIntent,
  isWellFormedUnicode,
  loadTypefullyPluginArtifact,
  normalizedText,
  safeTypefullyDraftId,
  safeTypefullyEditUrl,
  typefullyMetadata,
  typefullyPluginDefinition,
  typefullyResourceKey,
  validateTypefullyCandidate,
  validateTypefullyProposalInput,
};
export type { TypefullyAccount, TypefullyCandidate, TypefullyPlatform };
