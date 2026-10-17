import { apiFor } from '../session.mjs';
import { enc, integer, jsonData, positional, table } from '../format.mjs';
export const summary = 'Individual course tuition agreements and deferred installments';
export const help = `dataops tuition list [--search TEXT] [--status conditional|due|invoiced|settled|cancelled] [--limit N] [--cursor N]
dataops tuition show ID
dataops tuition add --data @agreement.json
dataops tuition update ID --data @agreement.json
Fields: studentName,title,trigger,status,amount,currency,dueOn,notes.
Clear amount and currency together with {"amount":null,"currency":null}.
Do not invent dates for conditional installments or book a student obligation and a platform payout as two revenues.`;
async function list(args, io) {
  const result = await apiFor(args).get('/api/tuition', { query: { search: args.search, status: args.status, limit: integer(args.limit, 'limit') ?? 30, cursor: args.cursor } });
  if (!args.json) table(io, result.items, [['ID', (item) => item.id], ['STUDENT', (item) => item.studentName], ['STATUS', (item) => item.status], ['TRIGGER', (item) => item.dueOn || item.trigger]], 'No agreements.');
  return result;
}
async function show(args, io) { const result = await apiFor(args).get(`/api/tuition/${enc(positional(args, 0, 'dataops tuition show ID'))}`); if (!args.json) io.print(JSON.stringify(result, null, 2)); return result; }
async function add(args, io) { const result = await apiFor(args).post('/api/tuition', jsonData(args)); if (!args.json) io.print(`Created tuition agreement ${result.id}.`); return result; }
async function update(args, io) {
  const id = positional(args, 0, 'dataops tuition update ID --data @agreement.json'), api = apiFor(args), data = jsonData(args);
  if (data.version === undefined) data.version = (await api.get(`/api/tuition/${enc(id)}`)).version;
  const result = await api.put(`/api/tuition/${enc(id)}`, data); if (!args.json) io.print(`Updated tuition agreement ${id}.`); return result;
}
export const commands = { list, show, add, update };
