import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { LambdaEvent, LambdaResponse } from '../types';
import { createBookingAtomic, createContactAtomic, createOrganizationAtomic, getCrmRecord, listBookingHistory, listCrmRecords, updateBookingAtomic, updateContactAtomic, updateOrganizationAtomic, type CrmRecord } from '../db/sponsorCrm';

const json = (statusCode: number, body: unknown): LambdaResponse => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = new Set(['inquiry','held','confirmed','materials-pending','materials-ready','scheduled','published','performance-due','complete','cancelled']);
const SLOT_TYPES = new Set(['main','secondary','standalone']);
const parse = (event: LambdaEvent) => { try { return event.body ? JSON.parse(String(event.body)) as Record<string, unknown> : null; } catch { return null; } };
const actor = (event: LambdaEvent) => Object.entries(event.headers || {}).find(([key]) => key.toLowerCase() === 'x-user-id')?.[1] || 'authenticated-operator';
const text = (value: unknown, max = 500) => typeof value === 'string' && value.trim() && value.length <= max;
const realDate = (value: unknown) => { if (typeof value !== 'string' || !DATE.test(value)) return false; const date = new Date(`${value}T00:00:00Z`); return date.toISOString().slice(0,10) === value; };
const page = (items: CrmRecord[], event: LambdaEvent) => {
  const query = event.queryStringParameters || {}, limit = Number(query.limit || 50), cursor = Number(query.cursor || 0);
  const sliced = items.slice(cursor, cursor + limit);
  return { items: sliced, nextCursor: cursor + limit < items.length ? String(cursor + limit) : null };
};
function validateList(event:LambdaEvent,kind:string){const query=event.queryStringParameters||{},limit=Number(query.limit||50),cursor=Number(query.cursor||0);if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(cursor)||cursor<0)return'Invalid pagination';if(query.status&&kind==='booking'&&!STATUSES.has(query.status))return'Invalid status filter';if(query.from&&!realDate(query.from))return'Invalid from date';if(query.to&&!realDate(query.to))return'Invalid to date';if(query.from&&query.to&&query.from>query.to)return'Invalid date range';if(query.organizationId&&!ID.test(query.organizationId))return'Invalid organizationId filter';if(query.active&&!['true','false'].includes(query.active))return'Invalid active filter';return'';}
const safeBookingSummary = (booking: CrmRecord) => ({ id: booking.id, organizationId: booking.organizationId, slotType: booking.slotType, status: booking.status, plannedPublicationDate: booking.plannedPublicationDate, scheduleEntryId: booking.scheduleEntryId, bundleId: booking.bundleId, version: booking.version, updatedAt: booking.updatedAt });
function validateOrganization(body: Record<string, unknown>, partial = false) { return (!partial && !text(body.displayName, 200)) || (body.displayName !== undefined && !text(body.displayName, 200)) || (body.notes !== undefined && typeof body.notes !== 'string') ? 'Invalid organization fields' : ''; }
function validateContact(body: Record<string, unknown>, partial = false) {
  if ((!partial && (!ID.test(String(body.organizationId || '')) || !text(body.name, 200))) || (body.name !== undefined && !text(body.name, 200))) return 'Invalid contact fields';
  if (body.emails !== undefined && (!Array.isArray(body.emails) || body.emails.length < 1 || body.emails.length > 10 || body.emails.some(email => typeof email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254))) return 'Invalid contact channels';
  return '';
}
function validateBooking(body: Record<string, unknown>, partial = false) {
  if (!partial && !ID.test(String(body.organizationId || ''))) return 'Invalid organizationId';
  if ((!partial || body.slotType !== undefined) && !SLOT_TYPES.has(String(body.slotType))) return 'Invalid slotType';
  if ((!partial || body.status !== undefined) && !STATUSES.has(String(body.status))) return 'Invalid status';
  for (const name of ['plannedPublicationDate','materialDeadline','nextActionDate']) if (body[name] != null && !realDate(body[name])) return `Invalid ${name}`;
  for (const name of ['primaryContactId','scheduleEntryId','bundleId']) if (body[name] != null && !ID.test(String(body[name]))) return `Invalid ${name}`;
  if (body.artifactUrls !== undefined && (!Array.isArray(body.artifactUrls) || body.artifactUrls.length > 20 || body.artifactUrls.some(url => { try { const parsed = new URL(String(url)); return parsed.protocol !== 'https:'; } catch { return true; } }))) return 'Invalid artifactUrls';
  return '';
}

export async function handleSponsorCrmRoutes(path: string, method: string, event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  const body = parse(event), user = actor(event);
  const lookupMatch=path.match(/^\/api\/sponsor-crm\/integrations\/newsletter\/bookings\/([^/]+)$/);
  if(lookupMatch&&method==='GET'){const booking=await getCrmRecord(client,'booking',lookupMatch[1]);return booking?json(200,safeBookingSummary(booking)):json(404,{error:'Not found'});}
  const historyMatch = path.match(/^\/api\/sponsor-crm\/bookings\/([^/]+)\/history$/);
  if (historyMatch && method === 'GET') return json(200, { items: await listBookingHistory(client, historyMatch[1]) });
  const linkMatch = path.match(/^\/api\/sponsor-crm\/bookings\/([^/]+)\/schedule-link$/);
  if (linkMatch && (method === 'PUT' || method === 'DELETE')) {
    const existing = await getCrmRecord(client, 'booking', linkMatch[1]); if (!existing) return json(404, { error: 'Not found' });
    const scheduleEntryId = method === 'DELETE' ? undefined : body?.scheduleEntryId;
    if (scheduleEntryId !== undefined && !ID.test(String(scheduleEntryId))) return json(400, { error: 'Invalid scheduleEntryId' });
    if (body?.version !== existing.version) return json(409, { error: 'Booking was changed; reload and retry' });
    try { return json(200, safeBookingSummary(await updateBookingAtomic(client,existing,{scheduleEntryId},user))); } catch (error) { if ((error as Error).name.includes('Transaction') || (error as Error).name.includes('Conditional')) return json(409, { error: 'Schedule entry is already linked' }); throw error; }
  }
  const match = path.match(/^\/api\/sponsor-crm\/(organizations|contacts|bookings)(?:\/([^/]+))?$/);
  if (!match) return json(404, { error: 'Not found' });
  const plural = match[1], id = match[2], kind = plural.slice(0, -1);
  if (id && !ID.test(id)) return json(400, { error: 'Invalid ID' });
  if (method === 'GET' && id) { const record = await getCrmRecord(client, kind, id); return record ? json(200, record) : json(404, { error: 'Not found' }); }
  if (method === 'GET' && !id) {
    const listError=validateList(event,kind);if(listError)return json(400,{error:listError});let items = await listCrmRecords(client, kind); const query = event.queryStringParameters || {};
    if (query.organizationId) items = items.filter(item => item.organizationId === query.organizationId);
    if (query.status) items = items.filter(item => item.status === query.status);
    if (query.active) items = items.filter(item => String(item.archivedAt ? false : true) === query.active);
    if (query.from) items = items.filter(item => !item.plannedPublicationDate || String(item.plannedPublicationDate) >= query.from!);
    if (query.to) items = items.filter(item => !item.plannedPublicationDate || String(item.plannedPublicationDate) <= query.to!);
    if (query.search) { const q = query.search.toLowerCase(); items = items.filter(item => [item.displayName,item.name,item.status].some(value => String(value || '').toLowerCase().includes(q))); }
    return json(200, page(items, event));
  }
  if (method === 'POST' && !id) {
    if (!body) return json(400, { error: 'Invalid JSON' });
    const error = kind === 'organization' ? validateOrganization(body) : kind === 'contact' ? validateContact(body) : validateBooking(body); if (error) return json(400, { error });
    if (kind !== 'organization') { const organization = await getCrmRecord(client, 'organization', String(body.organizationId)); if (!organization || organization.archivedAt) return json(422, { error: 'Invalid organization reference' }); }
    if (kind === 'booking' && body.primaryContactId) { const contact = await getCrmRecord(client, 'contact', String(body.primaryContactId)); if (!contact || contact.organizationId !== body.organizationId) return json(422, { error: 'Invalid primary contact reference' }); }
    try {
      const values={ ...body, active: body.active !== false, sourceType: body.sourceType || 'portal' };
      const created = kind==='booking'?await createBookingAtomic(client,values,user):kind==='contact'?await createContactAtomic(client,values,user):await createOrganizationAtomic(client,values,user);
      return json(created.duplicate ? 200 : 201, created.item);
    } catch (error) { const conflict=(error as Error).name.includes('Transaction')||(error as Error).name.includes('Conditional');return json((error as any).statusCode || (conflict ? 409 : 500), { error: (error as any).statusCode ? (error as Error).message : (conflict ? 'Exclusive CRM reference is already claimed' : 'Could not create record') }); }
  }
  if ((method === 'PUT' || method === 'PATCH') && id) {
    if (!body) return json(400, { error: 'Invalid JSON' }); const existing = await getCrmRecord(client, kind, id); if (!existing) return json(404, { error: 'Not found' });
    if (body.version !== existing.version) return json(409, { error: 'Record was changed; reload and retry' });
    const error = kind === 'organization' ? validateOrganization(body, true) : kind === 'contact' ? validateContact(body, true) : validateBooking(body, true); if (error) return json(400, { error });
    const nextOrganizationId=String(body.organizationId||existing.organizationId||'');if(kind!=='organization'){const organization=await getCrmRecord(client,'organization',nextOrganizationId);if(!organization||organization.archivedAt)return json(422,{error:'Invalid organization reference'});}
    if(kind==='booking'&&(body.primaryContactId!==undefined||body.organizationId!==undefined)){const contactId=String(body.primaryContactId||existing.primaryContactId||'');if(contactId){const contact=await getCrmRecord(client,'contact',contactId);if(!contact||contact.archivedAt||contact.organizationId!==nextOrganizationId)return json(422,{error:'Invalid primary contact reference'});}}
    try {
      if (kind === 'booking') return json(200,await updateBookingAtomic(client,existing,body,user));
      if(kind==='contact')return json(200,await updateContactAtomic(client,existing,body,user));
      return json(200,await updateOrganizationAtomic(client,existing,body,user));
    } catch (error) { return json((error as Error).name.includes('Transaction') || (error as Error).name.includes('Conditional') ? 409 : 500, { error: 'Conflicting update; reload and retry' }); }
  }
  if (method === 'DELETE' && id && kind !== 'booking') { const existing = await getCrmRecord(client, kind, id); if (!existing) return json(404, { error: 'Not found' });if(kind==='contact')return json(200,await updateContactAtomic(client,existing,{archivedAt:new Date().toISOString(),active:false,primary:false},user));return json(200,await updateOrganizationAtomic(client,existing,{archivedAt:new Date().toISOString(),active:false},user,'archived')); }
  return json(405, { error: 'Method not allowed' });
}
