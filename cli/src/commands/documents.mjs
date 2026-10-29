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
  dataops doc create --task ID --kind transcript|timecodes|summary|note --title TITLE [--file PATH | --content TEXT] [--from ID]
  dataops doc delete <id> --version N
  dataops doc export <id> [--format txt|md|docx] [--output PATH]
  dataops doc update <id> [--title TITLE] [--file PATH | --content TEXT] --version N

Content is plain text or Markdown. --version is the version you read before editing;
a stale save fails without overwriting someone else's changes.
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
  const result = await apiFor(args).delete(`/api/documents/${enc(id)}`, { query: { version } });
  if (!args.json) io.print('Document deleted; guest review links are no longer usable.');
  return result;
}
export const commands = { list, show, create, update, export: exportTaskDocument, delete: remove };
