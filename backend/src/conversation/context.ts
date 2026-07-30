import { createHash } from 'crypto';

interface ContextEvent {
  sequence: number;
  id: string;
  text: string;
}

interface SourceExcerpt {
  reference: string;
  revision?: string;
  text: string;
}

interface SummaryContext {
  checkpointId: string;
  revision: number;
  text: string;
}

interface ContextInput {
  conversationId: string;
  conversationRevision: number;
  coreRules: string;
  catalog: unknown;
  pluginContract?: {
    id: string;
    buildDigest: string;
    schemaDigest: string;
    content: unknown;
  };
  summary?: SummaryContext;
  recentEvents?: ContextEvent[];
  sourceExcerpts?: SourceExcerpt[];
  proposalStateReference?: string;
  provider: string;
  model: string;
}

interface ContextLimits {
  maximumInput: number;
  maximumOutput: number;
  summary: number;
  recentEvents: number;
  sourceExcerpts: number;
  proposalStateReference: number;
}

interface ContextReceipt {
  algorithmVersion: 'context-v1';
  conversationId: string;
  sourceRevision: number;
  summaryCheckpoint?: { id: string; revision: number; hash: string };
  includedEventSequences: Array<{ from: number; through: number; hashes: string[] }>;
  sourceReferences: Array<{ referenceHash: string; revisionHash?: string }>;
  plugin?: { id: string; buildDigest: string; schemaDigest: string };
  estimatedInputCount: number;
  limits: ContextLimits;
  truncation: {
    summary: boolean;
    recentEvents: boolean;
    sourceExcerpts: boolean;
    proposalStateReference: boolean;
  };
  provider: string;
  model: string;
}

interface AssembledContext {
  system: string;
  messages: Array<{ role: 'user'; content: string }>;
  receipt: ContextReceipt;
}

type TokenCounter = (value: string) => number;

const DEFAULT_CONTEXT_LIMITS: ContextLimits = {
  maximumInput: 16_384,
  maximumOutput: 4_096,
  summary: 2_048,
  recentEvents: 8_192,
  sourceExcerpts: 4_096,
  proposalStateReference: 512,
};
const SECRET_TEXT = /(?:bearer\s+\S+|(?:api[_-]?key|secret|token|password|credential|cookie|authorization)\s*[:=]\s*\S+|X-Amz-(?:Signature|Credential|Security-Token)=\S+)/ig;

class ContextConfigurationError extends Error {
  constructor(message = 'Conversational context configuration is invalid') {
    super(message);
    this.name = 'ContextConfigurationError';
  }
}

function conservativeTokenEstimate(value: string): number {
  return Math.ceil(Buffer.byteLength(value, 'utf8') / 3);
}

function hash(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function safeText(value: string): string {
  return value.replace(SECRET_TEXT, '[redacted]');
}

function boundedText(value: string, maximum: number, count: TokenCounter): { text: string; truncated: boolean } {
  const safe = safeText(value);
  if (count(safe) <= maximum) return { text: safe, truncated: false };
  let low = 0;
  let high = safe.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (count(safe.slice(0, middle)) <= maximum) low = middle;
    else high = middle - 1;
  }
  return { text: safe.slice(0, low), truncated: true };
}

function sequenceRanges(events: ContextEvent[]): ContextReceipt['includedEventSequences'] {
  const ranges: ContextReceipt['includedEventSequences'] = [];
  for (const event of events) {
    const eventHash = hash(`${event.id}:${event.sequence}:${event.text}`);
    const previous = ranges[ranges.length - 1];
    if (previous && previous.through + 1 === event.sequence) {
      previous.through = event.sequence;
      previous.hashes.push(eventHash);
    } else {
      ranges.push({ from: event.sequence, through: event.sequence, hashes: [eventHash] });
    }
  }
  return ranges;
}

class ContextAssembler {
  constructor(
    private readonly count: TokenCounter = conservativeTokenEstimate,
    private readonly limits: ContextLimits = DEFAULT_CONTEXT_LIMITS
  ) {
    if (
      limits.maximumInput <= 0
      || limits.maximumOutput <= 0
      || limits.summary < 0
      || limits.recentEvents < 0
      || limits.sourceExcerpts < 0
      || limits.proposalStateReference < 0
    ) throw new ContextConfigurationError();
  }

  assemble(input: ContextInput): AssembledContext {
    const mandatoryParts = [
      safeText(input.coreRules),
      `Available plugins:\n${JSON.stringify(input.catalog)}`,
    ];
    if (input.pluginContract) {
      mandatoryParts.push(`Active plugin:\n${JSON.stringify(input.pluginContract.content)}`);
    }
    const system = mandatoryParts.join('\n\n');
    if (this.count(system) > this.limits.maximumInput) {
      throw new ContextConfigurationError('Mandatory policy and plugin content exceeds the input limit');
    }

    const summary = input.summary
      ? boundedText(input.summary.text, this.limits.summary, this.count)
      : { text: '', truncated: false };
    const proposal = input.proposalStateReference
      ? boundedText(input.proposalStateReference, this.limits.proposalStateReference, this.count)
      : { text: '', truncated: false };
    const allEvents = [...(input.recentEvents || [])].sort((left, right) => left.sequence - right.sequence);
    const selectedEvents: ContextEvent[] = [];
    let eventTokens = 0;
    for (const event of [...allEvents].reverse()) {
      const safe = safeText(event.text);
      const cost = this.count(safe);
      if (eventTokens + cost > this.limits.recentEvents) continue;
      selectedEvents.unshift({ ...event, text: safe });
      eventTokens += cost;
    }
    const selectedSources: SourceExcerpt[] = [];
    let sourceTokens = 0;
    for (const source of input.sourceExcerpts || []) {
      const safe = safeText(source.text);
      const cost = this.count(safe);
      if (sourceTokens + cost > this.limits.sourceExcerpts) continue;
      selectedSources.push({ ...source, text: safe });
      sourceTokens += cost;
    }
    let summaryText = summary.text;
    let proposalText = proposal.text;
    let events = selectedEvents;
    let sources = selectedSources;

    const renderOptional = (): string => [
      summaryText ? `Summary:\n${summaryText}` : '',
      events.length ? `Recent events:\n${events.map((event) => `[${event.sequence}] ${event.text}`).join('\n')}` : '',
      sources.length ? `Source excerpts:\n${sources.map((source) => `[${source.reference}] ${source.text}`).join('\n')}` : '',
      proposalText ? `Proposal state reference:\n${proposalText}` : '',
    ].filter(Boolean).join('\n\n');
    const total = (): number => this.count(system) + this.count(renderOptional());

    while (total() > this.limits.maximumInput && events.length) events = events.slice(1);
    while (total() > this.limits.maximumInput && sources.length) sources = sources.slice(0, -1);
    if (total() > this.limits.maximumInput && summaryText) {
      const room = Math.max(0, this.limits.maximumInput - this.count(system) - this.count(renderOptional()) + this.count(summaryText));
      summaryText = boundedText(summaryText, room, this.count).text;
    }
    if (total() > this.limits.maximumInput && proposalText) {
      const room = Math.max(0, this.limits.maximumInput - this.count(system) - this.count(renderOptional()) + this.count(proposalText));
      proposalText = boundedText(proposalText, room, this.count).text;
    }
    if (total() > this.limits.maximumInput) throw new ContextConfigurationError();

    const optional = renderOptional();
    const receipt: ContextReceipt = {
      algorithmVersion: 'context-v1',
      conversationId: input.conversationId,
      sourceRevision: input.conversationRevision,
      ...(input.summary && summaryText ? {
        summaryCheckpoint: {
          id: input.summary.checkpointId,
          revision: input.summary.revision,
          hash: hash(summaryText),
        },
      } : {}),
      includedEventSequences: sequenceRanges(events),
      sourceReferences: sources.map((source) => ({
        referenceHash: hash(source.reference),
        ...(source.revision ? { revisionHash: hash(source.revision) } : {}),
      })),
      ...(input.pluginContract ? {
        plugin: {
          id: input.pluginContract.id,
          buildDigest: input.pluginContract.buildDigest,
          schemaDigest: input.pluginContract.schemaDigest,
        },
      } : {}),
      estimatedInputCount: total(),
      limits: { ...this.limits },
      truncation: {
        summary: summary.truncated || Boolean(input.summary && summaryText !== summary.text),
        recentEvents: events.length !== allEvents.length,
        sourceExcerpts: sources.length !== (input.sourceExcerpts || []).length,
        proposalStateReference: proposal.truncated || Boolean(input.proposalStateReference && proposalText !== input.proposalStateReference),
      },
      provider: input.provider,
      model: input.model,
    };
    return {
      system,
      messages: optional ? [{ role: 'user', content: optional }] : [],
      receipt,
    };
  }
}

export {
  ContextAssembler,
  ContextConfigurationError,
  DEFAULT_CONTEXT_LIMITS,
  conservativeTokenEstimate,
};
export type {
  AssembledContext,
  ContextEvent,
  ContextInput,
  ContextLimits,
  ContextReceipt,
  SourceExcerpt,
  SummaryContext,
  TokenCounter,
};
