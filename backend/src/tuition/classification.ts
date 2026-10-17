/** Course sponsorship is valid CRM; explicit individual tuition belongs in billing. */
export function isIndividualTuition(value: Record<string, unknown>): boolean {
  return value.recordType === 'tuition-agreement'
    || /\b(?:individual(?:\s+course)?\s+tuition\s+agreement|deferred(?:\s+course)?\s+tuition\s+installments?|tuition\s+installments?)\b/i.test(String(value.title || ''));
}
