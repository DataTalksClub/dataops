import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { listNewsletterSlots } from '../db/newsletterSlots';
import type { CalendarOverlayProvider } from './overlays';
export function newsletterCalendarOverlay(client:DynamoDBDocumentClient):CalendarOverlayProvider{return {name:'newsletter-slots-readonly',async project(from,to){const slots=await listNewsletterSlots(client,from,to);return slots.map(slot=>({provider:'newsletter-slots-readonly',id:slot.id,startDate:slot.publicationDate,endDate:slot.publicationDate,label:String(slot.campaignLabel||'Newsletter'),status:slot.status,href:`#/newsletter?slotId=${encodeURIComponent(slot.id)}`}));}};}
