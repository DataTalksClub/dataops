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
};

export type CalendarOverlayProvider = {
  name: string;
  project(from: string, to: string): Promise<CalendarOverlayItem[]>;
};

const providers: CalendarOverlayProvider[] = [];

export function registerCalendarOverlayProvider(provider: CalendarOverlayProvider) {
  if (!providers.some((p) => p.name === provider.name)) providers.push(provider);
}

export async function projectCalendarOverlays(from: string, to: string): Promise<CalendarOverlayItem[]> {
  const settled = await Promise.allSettled(providers.map((p) => p.project(from, to)));
  return settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : []));
}

export function resetCalendarOverlayProvidersForTests() {
  providers.length = 0;
}
