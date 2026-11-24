export interface GuestAgreement { agreedFrom?: string; agreedTo?: string }
export function validateGuestAgreement(input: GuestAgreement, requestedDate?: string): void {
  for (const key of ['agreedFrom', 'agreedTo'] as const) {
    const value = input[key];
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T12:00:00Z`)) || new Date(`${value}T12:00:00Z`).toISOString().slice(0,10) !== value) throw new Error('Record the guest agreement with agreedFrom and agreedTo as real YYYY-MM-DD dates before scheduling');
  }
  if (input.agreedFrom! > input.agreedTo!) throw new Error('Guest agreement dates must be in order');
  if (requestedDate && (requestedDate < input.agreedFrom! || requestedDate > input.agreedTo!)) throw new Error('Requested date is outside the guest agreement');
}
