import { createHash } from 'crypto';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TABLE_CALENDAR } from './tableNames';

export async function dismissCalendarAlert(client:DynamoDBDocumentClient,fingerprint:string,actor:string){const key=`ALERT#${createHash('sha256').update(fingerprint).digest('hex')}`;await client.send(new PutCommand({TableName:TABLE_CALENDAR,Item:{PK:key,SK:key,fingerprint,dismissedBy:actor,dismissedAt:new Date().toISOString()}}));}
export async function isCalendarAlertDismissed(client:DynamoDBDocumentClient,fingerprint:string){const key=`ALERT#${createHash('sha256').update(fingerprint).digest('hex')}`;return !!(await client.send(new GetCommand({TableName:TABLE_CALENDAR,Key:{PK:key,SK:key}}))).Item;}

export interface CalendarOverlaySettings {
  connectionId: string;
  filterLunch: boolean;
  filterRoutines: boolean;
  filterFitness: boolean;
  filterCampaigns: boolean;
  filterBusy: boolean;
  filterNonSlotHours: boolean;
  filterDtcPlaceholders: boolean;
  filterTransparent: boolean;
  customKeywords: string[];
  updatedAt?: string;
  updatedBy?: string;
}

export const DEFAULT_CALENDAR_OVERLAY_SETTINGS: CalendarOverlaySettings = {
  connectionId: '',
  filterLunch: true,
  filterRoutines: true,
  filterFitness: true,
  filterCampaigns: true,
  filterBusy: true,
  filterNonSlotHours: true,
  filterDtcPlaceholders: true,
  filterTransparent: true,
  customKeywords: [],
};

const SETTINGS_PK = 'CONFIG#owner-calendar';

export async function getCalendarOverlaySettings(client: DynamoDBDocumentClient): Promise<CalendarOverlaySettings> {
  const result = await client.send(new GetCommand({
    TableName: TABLE_CALENDAR,
    Key: { PK: SETTINGS_PK, SK: SETTINGS_PK },
  }));
  if (!result.Item) {
    return { ...DEFAULT_CALENDAR_OVERLAY_SETTINGS };
  }
  const { PK, SK, ...data } = result.Item;
  return {
    connectionId: typeof data.connectionId === 'string' ? data.connectionId.trim() : '',
    filterLunch: typeof data.filterLunch === 'boolean' ? data.filterLunch : DEFAULT_CALENDAR_OVERLAY_SETTINGS.filterLunch,
    filterRoutines: typeof data.filterRoutines === 'boolean' ? data.filterRoutines : DEFAULT_CALENDAR_OVERLAY_SETTINGS.filterRoutines,
    filterFitness: typeof data.filterFitness === 'boolean' ? data.filterFitness : DEFAULT_CALENDAR_OVERLAY_SETTINGS.filterFitness,
    filterCampaigns: typeof data.filterCampaigns === 'boolean' ? data.filterCampaigns : DEFAULT_CALENDAR_OVERLAY_SETTINGS.filterCampaigns,
    filterBusy: typeof data.filterBusy === 'boolean' ? data.filterBusy : DEFAULT_CALENDAR_OVERLAY_SETTINGS.filterBusy,
    filterNonSlotHours: typeof data.filterNonSlotHours === 'boolean' ? data.filterNonSlotHours : DEFAULT_CALENDAR_OVERLAY_SETTINGS.filterNonSlotHours,
    filterDtcPlaceholders: typeof data.filterDtcPlaceholders === 'boolean' ? data.filterDtcPlaceholders : DEFAULT_CALENDAR_OVERLAY_SETTINGS.filterDtcPlaceholders,
    filterTransparent: typeof data.filterTransparent === 'boolean' ? data.filterTransparent : DEFAULT_CALENDAR_OVERLAY_SETTINGS.filterTransparent,
    customKeywords: Array.isArray(data.customKeywords) ? data.customKeywords.filter((k: any) => typeof k === 'string' && k.trim()) : [],
    updatedAt: data.updatedAt as string | undefined,
    updatedBy: data.updatedBy as string | undefined,
  };
}

export async function saveCalendarOverlaySettings(
  client: DynamoDBDocumentClient,
  input: Partial<CalendarOverlaySettings>,
  actor: string
): Promise<CalendarOverlaySettings> {
  const current = await getCalendarOverlaySettings(client);
  const updated: CalendarOverlaySettings = {
    connectionId: typeof input.connectionId === 'string' ? input.connectionId.trim().slice(0, 128) : current.connectionId,
    filterLunch: typeof input.filterLunch === 'boolean' ? input.filterLunch : current.filterLunch,
    filterRoutines: typeof input.filterRoutines === 'boolean' ? input.filterRoutines : current.filterRoutines,
    filterFitness: typeof input.filterFitness === 'boolean' ? input.filterFitness : current.filterFitness,
    filterCampaigns: typeof input.filterCampaigns === 'boolean' ? input.filterCampaigns : current.filterCampaigns,
    filterBusy: typeof input.filterBusy === 'boolean' ? input.filterBusy : current.filterBusy,
    filterNonSlotHours: typeof input.filterNonSlotHours === 'boolean' ? input.filterNonSlotHours : current.filterNonSlotHours,
    filterDtcPlaceholders: typeof input.filterDtcPlaceholders === 'boolean' ? input.filterDtcPlaceholders : current.filterDtcPlaceholders,
    filterTransparent: typeof input.filterTransparent === 'boolean' ? input.filterTransparent : current.filterTransparent,
    customKeywords: Array.isArray(input.customKeywords)
      ? input.customKeywords
          .filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
          .map((k) => k.trim().slice(0, 100))
          .slice(0, 100)
      : current.customKeywords,
    updatedAt: new Date().toISOString(),
    updatedBy: actor,
  };

  await client.send(new PutCommand({
    TableName: TABLE_CALENDAR,
    Item: {
      PK: SETTINGS_PK,
      SK: SETTINGS_PK,
      ...updated,
    },
  }));

  return updated;
}

