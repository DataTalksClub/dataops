import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { LambdaEvent, LambdaResponse } from '../types';
import { berlinDate } from '../sponsorFinance/core';
import { realDate } from '../sponsorCrm/model';
import { getCrmRecord } from '../db/sponsorCrm';
import {
  appendContractAudit,
  checkContractRateLimit,
  contractTokenHash,
  createContract,
  dealHasSignedContract,
  getContract,
  ipHash,
  listContractAudit,
  listContracts,
  newSigningToken,
  recordContractFailedAttempt,
  updateContract,
  validContractEmail,
} from '../db/sponsorContracts';
import {
  DEFAULT_TOKEN_TTL_DAYS,
  publicContract,
  validateContractSigningLeadTime,
  validateContractTerms,
  type ContractRecord,
  type ContractSigner,
  type ContractStatus,
} from '../sponsorContracts/types';
import { renderContractPdf, sha256Hex, type AuditEvent } from '../sponsorContracts/pdf';
import { deliverContractEmail } from '../sponsorContracts/emailDelivery';
import { readFile, saveFile } from '../storage';
import { parseJsonObjectEvent as parse } from '../http';
import { sponsorDocPortalBaseUrl } from './sponsorDocs';

// Kept separate from http.json: also sends Cache-Control: no-store and Referrer-Policy: no-referrer, plus optional extraHeaders.
const json = (statusCode: number, body: unknown, extraHeaders?: Record<string, string>): LambdaResponse => ({ statusCode, headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }, extraHeaders), body: JSON.stringify(body) });
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const actor = (event: LambdaEvent) => Object.entries(event.headers || {}).find(([entryKey]) => entryKey.toLowerCase() === 'x-user-id')?.[1] || '';

function headerValue(headers: Record<string, string> | null | undefined, name: string): string {
  if (!headers) return '';
  const match = Object.entries(headers).find(([entryKey]) => entryKey.toLowerCase() === name.toLowerCase());
  return match ? String(match[1]) : '';
}

function requestIp(event: LambdaEvent): string {
  const forwarded = headerValue(event.headers, 'x-forwarded-for');
  return forwarded.split(',')[0].trim() || 'unknown';
}

function signingUrl(event: LambdaEvent, contractId: string, token: string): string {
  return sponsorDocPortalBaseUrl(event) + '/contracts/' + encodeURIComponent(contractId) + '?token=' + encodeURIComponent(token);
}

function providedToken(event: LambdaEvent, body?: Record<string, unknown> | null): string {
  const fromHeader = headerValue(event.headers, 'x-contract-token');
  if (fromHeader) return fromHeader;
  const fromQuery = event.queryStringParameters?.token;
  if (typeof fromQuery === 'string' && fromQuery.length > 0) return fromQuery;
  if (body && typeof body.token === 'string') return body.token;
  return '';
}

/** The signer whose turn it is: earliest order without a signedAt. */
export function pendingSigner(contract: Record<string, any>): ContractSigner | undefined {
  return [...(contract.signers || [])].sort((a, b) => a.order - b.order).find((signer) => !signer.signedAt);
}

function findSignerByToken(contract: Record<string, any>, token: string, now = new Date()): ContractSigner | undefined {
  if (!token) return undefined;
  const hash = contractTokenHash(token);
  return (contract.signers || []).find((signer: any) => signer.tokenHash === hash
    && (!signer.tokenExpiresAt || Date.parse(signer.tokenExpiresAt) > now.getTime()));
}

/** Anonymous external requests: token-gated signing page reads and actions. */
export function isAnonymousSponsorContractRequest(method: string, path: string): boolean {
  const m = method.toUpperCase();
  return /^(GET|POST)$/.test(m) && /^\x2Fapi\x2Fsponsor-crm\x2Fcontracts\x2F[^\x2F]+\x2F(signing|sign|decline)\x2F?$/.test(path);
}

async function renderAndStoreDraft(client: DynamoDBDocumentClient, contract: Record<string, any>) {
  const bytes = await renderContractPdf(contract.terms, { contractId: contract.id, signers: contract.signers || [] });
  const stored = await saveFile(contract.id, 'contract-draft.pdf', Buffer.from(bytes), 'application/pdf');
  return { storageProvider: stored.storageProvider, storagePath: stored.storagePath, storageUri: stored.storageUri };
}

async function respondPdf(client: DynamoDBDocumentClient, contract: Record<string, any>, which: 'signed' | 'draft'): Promise<LambdaResponse> {
  const target = which === 'signed' ? contract.signedPdf : contract.draftPdf;
  if (!target) return json(404, { error: 'No ' + which + ' PDF for this contract', code: 'contract_pdf_missing' });
  const bytes = await readFile(target);
  return { statusCode: 200, headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="contract-' + contract.id + '-' + which + '.pdf"', 'Cache-Control': 'no-store' }, body: Buffer.from(bytes).toString('base64'), isBase64Encoded: true };
}

function auditEventsOf(events: Record<string, any>[]): AuditEvent[] {
  return events.map((event: any) => ({
    action: String(event.action || event.newStatus || 'event'),
    at: String(event.createdAt || ''),
    ...(event.role ? { role: String(event.role) } : {}),
    ...(event.detail ? { detail: String(event.detail) } : {}),
    ...(event.ip ? { ip: String(event.ip) } : {}),
    ...(event.userAgent ? { userAgent: String(event.userAgent) } : {}),
  }));
}

export async function handleSponsorContractRoutes(reqPath: string, method: string, event: LambdaEvent, client: DynamoDBDocumentClient, opts: { skipAuth?: boolean } = {}): Promise<LambdaResponse> {
  const m = method.toUpperCase();
  const body = parse(event);
  const query = event.queryStringParameters || {};
  const nowDate = new Date(Date.now());
  const rawToday = typeof query.today === 'string' && query.today ? query.today : (body && typeof body.today === 'string' ? body.today : undefined);
  const explicitToday = realDate(rawToday);
  const today = explicitToday ? String(rawToday) : berlinDate(nowDate);
  const contractMatch = reqPath.match(/^\x2Fapi\x2Fsponsor-crm\x2Fcontracts\x2F([^\x2F]+)(\x2F.+)?$/);
  const contractId = contractMatch ? decodeURIComponent(contractMatch[1]) : '';
  // Anonymous token-gated signing endpoints never require a session.
  if (contractId && (reqPath.endsWith('/signing') || reqPath.endsWith('/sign') || reqPath.endsWith('/decline'))) {
    return await handleSigningRequest(reqPath, m, event, client, contractId, body, today, nowDate, explicitToday);
  }
  if (!actor(event) && !opts.skipAuth) return json(401, { error: 'Unauthorized' });

  // Staff: create a contract for a deal
  if (reqPath === '/api/sponsor-crm/contracts' && m === 'POST') {
    if (!body) return json(400, { error: 'Invalid JSON' });
    if (!ID.test(String(body.dealId || ''))) return json(400, { error: 'Invalid dealId' });
    const deal = await getCrmRecord(client, 'deal', String(body.dealId));
    if (!deal || deal.archivedAt) return json(422, { error: 'Invalid deal reference' });
    const validated = validateContractTerms(body.terms, today);
    if (validated.error || !validated.terms) return json(400, { error: validated.error || 'Invalid contract terms' });
    const sponsorSigner = await resolveSponsorSigner(client, body, deal);
    if (typeof sponsorSigner === 'string') return json(400, { error: sponsorSigner });
    const counterSigner = counterSignerFromBody(body);
    if (typeof counterSigner === 'string') return json(400, { error: counterSigner });
    const signers = orderedSigners(sponsorSigner, counterSigner, validated.terms.signingOrder);
    const created = await createContract(client, {
      dealId: deal.id, organizationId: deal.organizationId, status: 'draft', terms: validated.terms, signers,
    }, actor(event) || 'test-staff');
    const draftPdf = await renderAndStoreDraft(client, created);
    const withPdf = await updateContract(client, created, { draftPdf });
    return json(201, publicContract(withPdf as unknown as ContractRecord));
  }

  // Staff: list contracts (optionally for one deal)
  if (reqPath === '/api/sponsor-crm/contracts' && m === 'GET') {
    const items = await listContracts(client, query.dealId && ID.test(query.dealId) ? query.dealId : undefined);
    return json(200, { items: items.map(publicContract), nextCursor: null });
  }
  if (contractId && !ID.test(contractId)) return json(400, { error: 'Invalid contract id' });
  if (contractId && m === 'GET' && !reqPath.endsWith('/pdf') && !reqPath.endsWith('/audit')) {
    const contract = await getContract(client, contractId);
    if (!contract) return json(404, { error: 'Contract not found', code: 'contract_not_found' });
    return json(200, publicContract(contract));
  }

  // Staff: download draft or signed PDF
  const pdfMatch = contractId && reqPath.endsWith('/pdf');
  if (pdfMatch && m === 'GET') {
    const contract = await getContract(client, contractId);
    if (!contract) return json(404, { error: 'Contract not found', code: 'contract_not_found' });
    const which = query.which === 'draft' ? 'draft' : (contract.signedPdf ? 'signed' : 'draft');
    try {
      return await respondPdf(client, contract, which);
    } catch (error) {
      return json(503, { error: 'Stored PDF is unavailable: ' + String((error as Error).message || error), code: 'contract_pdf_unavailable' });
    }
  }

  // Staff: per-event audit trail
  const auditMatch = contractId && reqPath.endsWith('/audit');
  if (auditMatch && m === 'GET') {
    const contract = await getContract(client, contractId);
    if (!contract) return json(404, { error: 'Contract not found', code: 'contract_not_found' });
    const events = await listContractAudit(client, contractId);
    return json(200, { items: events });
  }

  // Staff: tamper check - recompute the SHA-256 of the stored signed PDF
  const verifyMatch = contractId && reqPath.endsWith('/verify');
  if (verifyMatch && m === 'POST') {
    const contract = await getContract(client, contractId);
    if (!contract) return json(404, { error: 'Contract not found', code: 'contract_not_found' });
    if (!contract.signedPdf) return json(409, { error: 'Contract has no signed PDF yet', code: 'contract_not_signed' });
    try {
      const bytes = await readFile(contract.signedPdf);
      const actual = sha256Hex(bytes);
      const intact = actual === contract.signedPdf.sha256;
      await appendContractAudit(client, contractId, { actorId: actor(event) || 'system', action: intact ? 'verified' : 'tamper-detected', detail: 'sha256 ' + actual });
      return json(200, { intact, expected: contract.signedPdf.sha256, actual });
    } catch (error) {
      return json(503, { error: 'Stored PDF is unavailable: ' + String((error as Error).message || error), code: 'contract_pdf_unavailable' });
    }
  }

  // Staff: send (or resend). Mints an expiring token per signer, emails the
  // sponsor signer, returns all signing URLs once (the counter-signer link is
  // handed over by staff instead of being emailed).
  if (contractId && (reqPath.endsWith('/send') || reqPath.endsWith('/resend')) && m === 'POST') {
    const contract = await getContract(client, contractId);
    if (!contract) return json(404, { error: 'Contract not found', code: 'contract_not_found' });
    if (contract.status === 'signed') return json(409, { error: 'Contract is already signed', code: 'contract_already_signed' });
    if (contract.status === 'declined') return json(409, { error: 'Contract was declined; create a new contract', code: 'contract_declined' });
    const expiresDays = Number((body || {}).expiresDays || DEFAULT_TOKEN_TTL_DAYS);
    if (!Number.isInteger(expiresDays) || expiresDays < 1 || expiresDays > 60) return json(400, { error: 'expiresDays must be a whole number from 1 to 60' });
    const now = new Date();
    const expiresAt = new Date(now.getTime() + expiresDays * 86400000).toISOString();
    const urls: Record<string, string> = {};
    const signers: ContractSigner[] = (contract.signers || []).map((signer: any) => {
      if (signer.signedAt) return signer;
      const token = newSigningToken();
      urls[signer.role] = signingUrl(event, contractId, token);
      return Object.assign({}, signer, { tokenHash: contractTokenHash(token), tokenExpiresAt: expiresAt });
    });
    if (!urls.sponsor) return json(409, { error: 'No unsigned sponsor signer to send to', code: 'contract_no_pending_signer' });
    const sponsorSigner = signers.find((signer) => signer.role === 'sponsor')!;
    const emailDelivery = await deliverContractEmail({
      to: sponsorSigner.email,
      subject: 'DataTalks.Club sponsorship agreement - signature requested',
      body: [
        'Hello ' + (sponsorSigner.name || sponsorSigner.email) + ',',
        '',
        'Please review and sign the sponsorship agreement for ' + contract.terms.company + ':',
        urls.sponsor,
        '',
        'The link is valid until ' + expiresAt + ' (UTC) and is meant for ' + sponsorSigner.email + ' only.',
        'Signing happens electronically under EU regulation 910/2014 (eIDAS) as a Simple Electronic Signature.',
      ].join(String.fromCharCode(10)),
    });
    const resend = reqPath.endsWith('/resend');
    const updated = await updateContract(client, contract, {
      status: 'sent' as ContractStatus,
      sentAt: contract.sentAt && resend ? contract.sentAt : now.toISOString(),
      signers,
      emailState: emailDelivery.state,
      emailReason: emailDelivery.reason,
    }, { actorId: actor(event) || 'test-staff', action: resend ? 'resent' : 'sent', role: 'sponsor', detail: 'Signing link emailed to ' + sponsorSigner.email });
    return json(200, { contract: publicContract(updated), emailDelivery, signingUrls: urls });
  }
  return json(404, { error: 'Not found' });
}

function orderedSigners(sponsor: ContractSigner, counter: ContractSigner, order: string): ContractSigner[] {
  const sponsorFirst = order !== 'counter-first';
  const first = Object.assign({}, sponsorFirst ? sponsor : counter, { order: 0 });
  const second = Object.assign({}, sponsorFirst ? counter : sponsor, { order: 1 });
  return [first, second];
}

async function resolveSponsorSigner(client: DynamoDBDocumentClient, body: Record<string, unknown>, deal: Record<string, any>): Promise<ContractSigner | string> {
  const raw = (body.sponsorSigner && typeof body.sponsorSigner === 'object' && !Array.isArray(body.sponsorSigner)) ? body.sponsorSigner as Record<string, unknown> : {};
  let email = validContractEmail(raw.email) ? String(raw.email).trim().toLowerCase() : '';
  let name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : '';
  if (deal.primaryContactId) {
    const contact = await getCrmRecord(client, 'contact', String(deal.primaryContactId));
    if (contact && !contact.archivedAt) {
      if (!name && typeof contact.name === 'string') name = contact.name.trim();
      if (!email && Array.isArray(contact.emails)) {
        email = contact.emails.map((item) => String(item || '').trim().toLowerCase()).find((item) => validContractEmail(item)) || '';
      }
    }
  }
  if (!email) return 'No sponsor signer email: pass sponsorSigner.email or set a primary contact with an email on the deal';
  return { role: 'sponsor', name: name || email, email, order: 0 };
}

function counterSignerFromBody(body: Record<string, unknown>): ContractSigner | string {
  const raw = (body.counterSigner && typeof body.counterSigner === 'object' && !Array.isArray(body.counterSigner)) ? body.counterSigner as Record<string, unknown> : {};
  const email = validContractEmail(raw.email) ? String(raw.email).trim().toLowerCase()
    : validContractEmail(process.env.DATAOPS_CONTRACT_COUNTERSIGNER_EMAIL) ? String(process.env.DATAOPS_CONTRACT_COUNTERSIGNER_EMAIL) : 'alexey@datatalks.club';
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : (process.env.DATAOPS_CONTRACT_COUNTERSIGNER_NAME || 'Alexey Grigorev (DataTalks.Club)');
  return { role: 'counter', name, email, order: 1 };
}

async function handleSigningRequest(
  reqPath: string,
  m: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
  contractId: string,
  body: Record<string, unknown> | null,
  today = berlinDate(),
  nowDate = new Date(Date.now()),
  explicitToday = false,
): Promise<LambdaResponse> {
  const ip = requestIp(event);
  const hashedIp = ipHash(ip);
  const limited = await checkContractRateLimit(client, contractId, hashedIp, nowDate);
  if (!limited.allowed) return json(429, { error: 'Too many attempts; try again later', code: 'rate_limited' }, { 'Retry-After': String(limited.retryAfterSeconds) });
  const contract = await getContract(client, contractId);
  if (!contract) return json(404, { error: 'Contract not found', code: 'contract_not_found' });
  const token = providedToken(event, body);
  const signer = findSignerByToken(contract, token, nowDate);
  if (!signer) {
    await recordContractFailedAttempt(client, contractId, hashedIp, nowDate);
    return json(403, { error: 'This signing link is invalid or expired', code: 'invalid_signing_token' });
  }
  const userAgent = headerValue(event.headers, 'user-agent').slice(0, 300);
  const now = nowDate.toISOString();
  const isView = reqPath.endsWith('/signing');
  if (isView) {
    if (m !== 'GET') return json(405, { error: 'Method not allowed' });
    let current: Record<string, any> = contract;
    if (contract.status === 'sent' && !signer.viewedAt) {
      const signers = (contract.signers || []).map((item: any) => item.role === signer.role && !item.viewedAt ? Object.assign({}, item, { viewedAt: now }) : item);
      current = await updateContract(client, contract, { status: 'viewed', viewedAt: now, signers }, { actorId: 'signer:' + signer.role, action: 'viewed', role: signer.role, ip, userAgent });
    }
    const pending = pendingSigner(current);
    return json(200, { contract: publicContract(current), viewer: { role: signer.role, name: signer.name }, pendingRole: pending ? pending.role : null });
  }
  if (m !== 'POST') return json(405, { error: 'Method not allowed' });
  if (contract.status === 'signed') return json(409, { error: 'Contract is already signed', code: 'contract_already_signed' });
  if (contract.status === 'declined') return json(409, { error: 'Contract was declined', code: 'contract_declined' });
  const pending = pendingSigner(contract);
  if (!pending || pending.role !== signer.role) {
    return json(409, { error: 'Signing order: it is not this signer\x27s turn (next: ' + (pending ? pending.role : 'none') + ')', code: 'signer_out_of_order' });
  }
  const withStamp = (item: ContractSigner) => item.role === signer.role
    ? Object.assign({}, item, reqPath.endsWith('/decline') ? { declinedAt: now, ip, userAgent } : { signedAt: now, ip, userAgent })
    : item;
  const nextSigners = (contract.signers || []).map(withStamp);
  if (reqPath.endsWith('/decline')) {
    const updated = await updateContract(client, contract, { status: 'declined', declinedAt: now, signers: nextSigners }, { actorId: 'signer:' + signer.role, action: 'declined', role: signer.role, ip, userAgent });
    return json(200, { contract: publicContract(updated) });
  }
  const createdDay = contract.createdAt && !Number.isNaN(Date.parse(String(contract.createdAt)))
    ? berlinDate(new Date(String(contract.createdAt)))
    : '';
  const enforceWallClockSigners = !explicitToday || !createdDay || String(contract.terms?.startDate || '') >= createdDay;
  const leadTimeError = validateContractSigningLeadTime(
    contract.terms,
    today,
    enforceWallClockSigners ? nextSigners : [],
    (iso) => {
      const ms = Date.parse(iso);
      return Number.isNaN(ms) ? '' : berlinDate(new Date(ms));
    },
  );
  if (leadTimeError) {
    return json(409, { error: leadTimeError, code: 'contract_lead_time_expired' });
  }
  const allSigned = nextSigners.every((item: any) => item.signedAt);
  if (!allSigned) {
    const nextStatus = contract.status === 'sent' ? 'viewed' : contract.status;
    const updated = await updateContract(client, contract, { status: nextStatus, signers: nextSigners }, { actorId: 'signer:' + signer.role, action: 'signed', role: signer.role, ip, userAgent });
    await appendContractAudit(client, contractId, { actorId: 'signer:' + signer.role, action: 'signed', role: signer.role, detail: 'Signed by ' + signer.name, ip, userAgent });
    const stillPending = pendingSigner(updated as unknown as ContractRecord);
    return json(200, { contract: publicContract(updated), awaitingRole: stillPending ? stillPending.role : null });
  }
  // Final signature: render the flattened signed PDF with the audit page,
  // store it and keep its SHA-256 on the record for the tamper check.
  const priorEvents = await listContractAudit(client, contractId);
  const auditEvents: AuditEvent[] = auditEventsOf(priorEvents);
  auditEvents.push({ action: 'signed', at: now, role: signer.role, detail: 'Signed by ' + signer.name, ip, userAgent });
  auditEvents.push({ action: 'completed', at: now, detail: 'All signers have signed; document finalized and hashed' });
  const bytes = await renderContractPdf(contract.terms, { contractId, signers: nextSigners, auditEvents });
  const stored = await saveFile(contractId, 'contract-signed.pdf', Buffer.from(bytes), 'application/pdf');
  const signedPdf = { storageProvider: stored.storageProvider, storagePath: stored.storagePath, storageUri: stored.storageUri, sha256: sha256Hex(bytes) };
  const updated = await updateContract(client, contract, { status: 'signed' as ContractStatus, signedAt: now, signers: nextSigners, signedPdf }, { actorId: 'signer:' + signer.role, action: 'completed', role: signer.role, detail: 'Final PDF stored (sha256 ' + signedPdf.sha256 + ')', ip, userAgent });
  return json(200, { contract: publicContract(updated), sha256: signedPdf.sha256 });
}

/** Browser page and static assets required to render the standalone
 * /contracts/:id signing page for an external signer without a session. */
export function isAnonymousSponsorContractAsset(method: string, path: string): boolean {
  if (method.toUpperCase() !== 'GET') return false;
  if (/^\x2Fcontracts\x2F[^\x2F]+\x2F?$/.test(path)) return true;
  return path === '/src/contract-sign-page.js' || path === '/src/surfaces/operations/contract-sign.js';
}
