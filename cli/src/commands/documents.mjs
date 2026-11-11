import { resolveProfile } from '../config.mjs';
import { exportTaskDocument } from './documents-transfer.mjs';
import { readFileSync } from 'node:fs';
import { UsageError } from '../errors.mjs';
import { enc, fields, positional, required, table } from '../format.mjs';
import { apiFor } from '../session.mjs';

export const summary = 'Task documents: transcripts, timecodes, summaries and notes';
export const help = `dataops doc - editable task documents

Usage
  dataops doc list --task ID
  dataops doc show <id>
  dataops doc preview <id>
  dataops doc create --task ID --kind transcript|timecodes|summary|note --title TITLE [--file PATH | --content TEXT] [--from ID]
  dataops doc delete <id> --version N
  dataops doc export <id> [--format txt|md|docx|pdf] [--output PATH]
  dataops doc update <id> [--title TITLE] [--file PATH | --content TEXT] --version N
  dataops doc comment list <id>
  dataops doc comment add <id> --body TEXT [--quote TEXT]
  dataops doc comment reply <id> <thread-id> --body TEXT --version N
  dataops doc comment resolve <id> <thread-id> --version N [--reopen]
  dataops doc comment delete <id> <thread-id> --version N
  dataops doc reviewer list <id>
  dataops doc reviewer add <id> --name NAME
  dataops doc reviewer revoke <id> <reviewer-id>

Content is plain text or Markdown. --version is the version you read before editing;
a stale save fails without overwriting someone else's changes. Comment threads use the
same --version optimistic locking. Reviewers get a read/comment link; they cannot edit
the document or manage reviewers, and the link expires after 30 days or on revoke.
`;
function content(args) {
  if (args.file !== undefined && args.content !== undefined) throw new UsageError('Use --file or --content.');
  return args.file !== undefined ? readFileSync(String(args.file), 'utf8') : args.content;
}
export async function list(args, io) {
  const result = await apiFor(args).get('/api/documents', { query: { taskId: required(args, 'task', 'task') } });
  if (!args.json) table(io, result.documents, [['ID', d => d.id], ['KIND', d => d.kind], ['TITLE', d => d.title], ['VERSION', d => d.version]], 'No documents.');
  return result;
}
export async function show(args, io) {
  const result = await apiFor(args).get(`/api/documents/${enc(positional(args, 0, 'doc show <id>'))}`);
  if (!args.json) fields(io, Object.entries(result.document));
  return result;
}
export async function create(args, io) {
  const body = { taskId: required(args, 'task', 'task'), title: args.title, kind: args.kind, content: content(args), from: args.from };
  if (!args.from) {
    body.title = required(args, 'title', 'title'); body.kind = required(args, 'kind', 'kind'); body.content ??= '';
  }
  const result = await apiFor(args).post('/api/documents', body);
  if (!args.json) fields(io, [['id', result.document.id], ['version', result.document.version]]);
  return result;
}
export async function update(args, io) {
  const id = positional(args, 0, 'doc update <id>');
  const version = Number(required(args, 'version', 'version'));
  if (!Number.isSafeInteger(version) || version < 1) throw new UsageError('--version must be a positive integer.');
  const api = apiFor(args);
  const current = (await api.get(`/api/documents/${enc(id)}`)).document;
  const result = await api.put(`/api/documents/${enc(id)}`, { title: args.title ?? current.title, content: content(args) ?? current.content, version });
  if (!args.json) fields(io, [['id', result.document.id], ['version', result.document.version]]);
  return result;
}
export async function remove(args, io) {
  const id = positional(args, 0, 'dataops doc delete <id> --version N');
  const version = Number(required(args, 'version', 'version'));
  if (!Number.isSafeInteger(version) || version < 1) throw new UsageError('--version must be a positive integer.');
  const result = await apiFor(args).delete(`/api/documents/${enc(id)}`, undefined, { query: { version } });
  if (!args.json) io.print('Document deleted; guest review links are no longer usable.');
  return result;
}
function editVersion(args) {
  const version = Number(required(args, 'version', 'version'));
  if (!Number.isSafeInteger(version) || version < 1) throw new UsageError('--version must be a positive integer.');
  return version;
}
function summaryLine(thread) {
  const last = thread.posts[thread.posts.length - 1];
  return `${thread.posts.length} post${thread.posts.length === 1 ? '' : 's'}, last by ${last.author.name}: ${last.body}`;
}
async function commentList(args, io) {
  const id = positional(args, 0, 'dataops doc comment list <id>');
  const result = await apiFor(args).get(`/api/documents/${enc(id)}/comments`);
  if (!args.json) {
    table(io, result.threads, [
      ['THREAD', t => t.id], ['QUOTE', t => t.quote || '-'], ['RESOLVED', t => (t.resolved ? `yes (${t.resolvedBy?.name || '?'})` : 'no')],
      ['VERSION', t => t.version], ['UPDATED', t => t.updatedAt], ['LAST', summaryLine],
    ], 'No comment threads.');
  }
  return result;
}
async function commentAdd(args, io) {
  const id = positional(args, 0, 'dataops doc comment add <id> --body TEXT');
  const body = { body: required(args, 'body', 'body'), ...(args.quote !== undefined ? { quote: args.quote } : {}) };
  const result = await apiFor(args).post(`/api/documents/${enc(id)}/comments`, body);
  if (!args.json) io.print(`Thread ${result.thread.id} created (version ${result.thread.version}).`);
  return result;
}
async function commentReply(args, io) {
  const usage = 'dataops doc comment reply <id> <thread-id> --body TEXT --version N';
  const id = positional(args, 0, usage);
  const threadId = positional(args, 1, usage);
  const result = await apiFor(args).post(`/api/documents/${enc(id)}/comments/${enc(threadId)}/reply`, { body: required(args, 'body', 'body'), version: editVersion(args) });
  if (!args.json) io.print(`Thread ${threadId} now has ${result.thread.posts.length} posts (version ${result.thread.version}).`);
  return result;
}
async function commentResolve(args, io) {
  const usage = 'dataops doc comment resolve <id> <thread-id> --version N [--reopen]';
  const id = positional(args, 0, usage);
  const threadId = positional(args, 1, usage);
  const resolved = !args.reopen;
  const result = await apiFor(args).post(`/api/documents/${enc(id)}/comments/${enc(threadId)}/resolve`, { resolved, version: editVersion(args) });
  if (!args.json) io.print(`Thread ${threadId} ${resolved ? 'resolved' : 'reopened'} (version ${result.thread.version}).`);
  return result;
}
async function commentDelete(args, io) {
  const usage = 'dataops doc comment delete <id> <thread-id> --version N';
  const id = positional(args, 0, usage);
  const threadId = positional(args, 1, usage);
  await apiFor(args).delete(`/api/documents/${enc(id)}/comments/${enc(threadId)}`, undefined, { query: { version: editVersion(args) } });
  if (!args.json) io.print(`Thread ${threadId} deleted.`);
  return { deleted: true };
}
export async function comment(args, io) {
  return subcommand(commentCommands, args, io, 'dataops doc comment', 'comment');
}
async function reviewerList(args, io) {
  const id = positional(args, 0, 'dataops doc reviewer list <id>');
  const result = await apiFor(args).get(`/api/documents/${enc(id)}/reviewers`);
  if (!args.json) table(io, result.reviewers, [['ID', r => r.id], ['NAME', r => r.name], ['CREATED', r => r.createdAt], ['EXPIRES', r => r.expiresAt]], 'No reviewers.');
  return result;
}
async function reviewerAdd(args, io) {
  const id = positional(args, 0, 'dataops doc reviewer add <id> --name NAME');
  const result = await apiFor(args).post(`/api/documents/${enc(id)}/reviewers`, { name: required(args, 'name', 'name') });
  if (!args.json) {
    io.print(`Reviewer ${result.reviewer.id} (${result.reviewer.name}) added; link expires ${result.reviewer.expiresAt}.`);
    io.print(`Review link: ${result.reviewPath}`);
  }
  return result;
}
async function reviewerRevoke(args, io) {
  const usage = 'dataops doc reviewer revoke <id> <reviewer-id>';
  const id = positional(args, 0, usage);
  const reviewerId = positional(args, 1, usage);
  await apiFor(args).delete(`/api/documents/${enc(id)}/reviewers/${enc(reviewerId)}`);
  if (!args.json) io.print(`Reviewer ${reviewerId} revoked.`);
  return { revoked: true };
}
export async function reviewer(args, io) {
  return subcommand(reviewerCommands, args, io, 'dataops doc reviewer', 'reviewer');
}
function subcommand(map, args, io, prefix, name) {
  const [action, ...rest] = args._ || [];
  if (!action) throw new UsageError(`Missing ${name} action. One of: ${Object.keys(map).join(', ')} (usage: ${prefix} <${Object.keys(map).join('|')}> ...).`);
  const fn = map[action];
  if (!fn) throw new UsageError(`Unknown ${name} action: ${prefix} ${action}. One of: ${Object.keys(map).join(', ')}.`);
  return fn({ ...args, _: rest }, io);
}
const commentCommands = { list: commentList, add: commentAdd, reply: commentReply, resolve: commentResolve, delete: commentDelete };
const reviewerCommands = { list: reviewerList, add: reviewerAdd, revoke: reviewerRevoke };
function preview(args, io) {
  const id = positional(args, 0, 'dataops doc preview <id>');
  const url = `${resolveProfile(args).url}/api/documents/${enc(id)}/preview`;
  if (!args.json) io.print(url);
  return { url };
}
export const commands = { preview, list, show, create, update, export: exportTaskDocument, delete: remove, comment, reviewer };
