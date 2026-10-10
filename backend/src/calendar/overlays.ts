export type CalendarOverlayItem = {
  provider: string;
  id: string;
  startDate: string;
  endDate: string;
  label: string;
  status?: string;
  href?: string;
  category?: string;
  startsAt?: string;
  endsAt?: string;
  slot?: 'midday' | 'evening' | 'all-day' | 'outside';
  isSlotEvent?: boolean;
  isAvailableSlot?: boolean;
};

export type CalendarOverlayProvider = {
  name: string;
  project(from: string, to: string): Promise<CalendarOverlayItem[]>;
};

const providers: CalendarOverlayProvider[] = [];

export function registerCalendarOverlayProvider(provider: CalendarOverlayProvider) {
  const existingIndex = providers.findIndex((p) => p.name === provider.name);
  if (existingIndex >= 0) {
    providers[existingIndex] = provider;
  } else {
    providers.push(provider);
  }
}

export async function projectCalendarOverlays(from: string, to: string): Promise<CalendarOverlayItem[]> {
  const settled = await Promise.allSettled(providers.map((p) => p.project(from, to)));
  return settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : []));
}

export function resetCalendarOverlayProvidersForTests() {
  providers.length = 0;
}
