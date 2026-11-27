export interface SplitGuestIdentity {
  guestName: string;
  guestRole: string;
  guestCompany: string;
  ambiguous: boolean;
}

const ROLE_HINT_RE = /\b(?:engineer|developer|architect|scientist|analyst|researcher|professor|lecturer|founder|co-founder|cofounder|ceo|cto|coo|cpo|cfo|vp|director|head|lead|manager|principal|staff|partner|consultant|specialist|evangelist|advocate|fellow|intern)\b/i;

function splitRoleAndCompany(rest: string): { role: string; company: string } | null {
  const trimmed = rest.trim();
  if (!trimmed) return null;

  const atMatch = /^(.+?)\s+(?:at|@)\s+(.+)$/i.exec(trimmed);
  if (atMatch) {
    return { role: atMatch[1].trim(), company: atMatch[2].trim() };
  }

  const slashParts = trimmed.split(/\s*[\/|]\s*/).map((p) => p.trim()).filter(Boolean);
  if (slashParts.length === 2) {
    return { role: slashParts[0], company: slashParts[1] };
  }

  return null;
}

/**
 * Best-effort split of a legacy combined `guestName` string
 * ("Guest Name & Role / Company") into `{ guestName, guestRole, guestCompany }`.
 * Never drops text: if the split is ambiguous, the original value stays in `guestName`.
 */
export function splitCombinedGuestIdentity(raw: string | undefined | null): SplitGuestIdentity {
  const normalized = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return { guestName: '', guestRole: '', guestCompany: '', ambiguous: false };
  }

  // 1. Parenthetical: "Name (Role at Company)" or "Name (Role / Company)" or "Name (Role, Company)"
  const parenMatch = /^(.+?)\s*\(([^()]+)\)$/.exec(normalized);
  if (parenMatch) {
    const namePart = parenMatch[1].trim();
    const inner = parenMatch[2].trim();
    const rc = splitRoleAndCompany(inner);
    if (rc) {
      return { guestName: namePart, guestRole: rc.role, guestCompany: rc.company, ambiguous: false };
    }
    const commaParts = inner.split(',').map((p) => p.trim()).filter(Boolean);
    if (commaParts.length === 2) {
      return { guestName: namePart, guestRole: commaParts[0], guestCompany: commaParts[1], ambiguous: false };
    }
    if (ROLE_HINT_RE.test(inner)) {
      return { guestName: namePart, guestRole: inner, guestCompany: '', ambiguous: false };
    }
  }

  // 2. Comma-separated: "Name, Role at Company" / "Name, Role / Company" / "Name, Role, Company" / "Name, Role"
  const commaParts = normalized.split(',').map((p) => p.trim()).filter(Boolean);
  if (commaParts.length === 2) {
    const [namePart, rest] = commaParts;
    const rc = splitRoleAndCompany(rest);
    if (rc) {
      return { guestName: namePart, guestRole: rc.role, guestCompany: rc.company, ambiguous: false };
    }
    if (ROLE_HINT_RE.test(rest)) {
      return { guestName: namePart, guestRole: rest, guestCompany: '', ambiguous: false };
    }
    return { guestName: namePart, guestRole: '', guestCompany: rest, ambiguous: false };
  }
  if (commaParts.length === 3) {
    return { guestName: commaParts[0], guestRole: commaParts[1], guestCompany: commaParts[2], ambiguous: false };
  }

  // 3. Dash-separated: "Name - Role at Company" or "Name — Role / Company"
  const dashMatch = /^(.+?)\s+[-–—]\s+(.+)$/.exec(normalized);
  if (dashMatch) {
    const rc = splitRoleAndCompany(dashMatch[2]);
    if (rc) {
      return { guestName: dashMatch[1].trim(), guestRole: rc.role, guestCompany: rc.company, ambiguous: false };
    }
  }

  // 4. Slash/pipe-separated: "Name / Role / Company" or "Name Role / Company"
  const slashParts = normalized.split(/\s*[\/|]\s*/).map((p) => p.trim()).filter(Boolean);
  if (slashParts.length === 3) {
    return { guestName: slashParts[0], guestRole: slashParts[1], guestCompany: slashParts[2], ambiguous: false };
  }
  if (slashParts.length === 2) {
    const [left, right] = slashParts;
    const leftWords = left.split(/\s+/);
    // e.g. "Jordan Taylor Forward Deployed Engineer / Eliza"
    if (leftWords.length >= 4 && ROLE_HINT_RE.test(leftWords.slice(2).join(' '))) {
      return {
        guestName: leftWords.slice(0, 2).join(' '),
        guestRole: leftWords.slice(2).join(' '),
        guestCompany: right,
        ambiguous: false,
      };
    }
    // e.g. "Jordan Taylor / Eliza"
    if (leftWords.length <= 3) {
      return { guestName: left, guestRole: '', guestCompany: right, ambiguous: false };
    }
  }

  // 5. "Name Role at/@ Company" without comma
  const atMatch = /^(.+?)\s+(?:at|@)\s+(.+)$/i.exec(normalized);
  if (atMatch) {
    const leftWords = atMatch[1].trim().split(/\s+/);
    if (leftWords.length >= 3 && ROLE_HINT_RE.test(leftWords.slice(2).join(' '))) {
      return {
        guestName: leftWords.slice(0, 2).join(' '),
        guestRole: leftWords.slice(2).join(' '),
        guestCompany: atMatch[2].trim(),
        ambiguous: false,
      };
    }
  }

  // 6. Plain name (1-3 words without punctuation)
  const words = normalized.split(/\s+/);
  if (words.length <= 3 && !/[\/,|]/.test(normalized) && !ROLE_HINT_RE.test(normalized)) {
    return { guestName: normalized, guestRole: '', guestCompany: '', ambiguous: false };
  }

  // Ambiguous: preserve full original value in guestName so nothing is lost.
  return { guestName: normalized, guestRole: '', guestCompany: '', ambiguous: true };
}
