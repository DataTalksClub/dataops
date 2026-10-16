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
  /** A newsletter issue's kind, number and slot state (newsletter overlay only). */
  newsletter?: {
    kind: string;
    issueNumber: number | null;
    slots: { position: string; sponsor: string | null }[];
    booked: number;
    /** The issue's Card, or when the daily run creates it. */
    cardId: string | null;
    cardDueDate: string | null;
  };
};

/**
 * Whether an overlay source could be read. An empty `items` list only means
 * "nothing in range" when the source is `connected`; otherwise the reason says
 * why the layer is blank. Reasons are operator-facing and never carry secrets.
 */
export type CalendarOverlayConnection = {
  state: 'connected' | 'not-configured' | 'unavailable';
  reason?: string;
};

export type CalendarOverlayProjection = {
  items: CalendarOverlayItem[];
  connection: CalendarOverlayConnection;
};

export type CalendarOverlayProvider = {
  name: string;
  project(from: string, to: string): Promise<CalendarOverlayProjection>;
};

/** Projects the given overlay sources over a date range, one request at a time. */
export async function projectCalendarOverlays(from: string, to: string, providers: CalendarOverlayProvider[]): Promise<{
  items: CalendarOverlayItem[];
  sources: Record<string, CalendarOverlayConnection>;
}> {
  const settled = await Promise.allSettled(providers.map((p) => p.project(from, to)));
  const items: CalendarOverlayItem[] = [];
  const sources: Record<string, CalendarOverlayConnection> = {};
  settled.forEach((result, index) => {
    const name = providers[index].name;
    if (result.status === 'fulfilled') {
      items.push(...result.value.items);
      sources[name] = result.value.connection;
    } else {
      sources[name] = { state: 'unavailable', reason: 'The overlay source failed to load.' };
    }
  });
  return { items, sources };
}
