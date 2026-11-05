import { UsageError } from '../errors.mjs';
import { apiFor } from '../session.mjs';
import { enc, optionalString, positional } from '../format.mjs';

export async function banner(args, io) {
  const cardId = positional(args, 0, 'dataops cards banner <card-id> --event-type workshop|webinar|podcast --layout landscape|square --speakers PERSON:PORTRAIT_FILE[,PERSON:PORTRAIT_FILE] --revision LABEL [--wait]');
  const api = apiFor(args);
  const base = `/api/cards/${enc(cardId)}/banners`;
  const jobId = optionalString(args, 'job');
  let result;
  if (jobId) result = await api.get(`${base}/${enc(jobId)}`);
  else {
    const selections = optionalString(args, 'speakers');
    if (!selections) throw new UsageError('--speakers PERSON:PORTRAIT_FILE[,PERSON:PORTRAIT_FILE] is required. Select source-verified portraits already saved on this Card.');
    const speakers = selections.split(',').map(value => {
      const pair = value.split(':');
      if (pair.length !== 2 || pair.some(part => !part)) throw new UsageError('Each speaker must be PERSON_ID:PORTRAIT_FILE_ID.');
      return { personId: pair[0], portraitFileId: pair[1] };
    });
    result = await api.post(base, { eventType: optionalString(args, 'eventType'), layout: optionalString(args, 'layout'), revision: optionalString(args, 'revision'), speakers,
      sponsorLogoFileId: optionalString(args, 'sponsorLogo'), sponsorTreatment: optionalString(args, 'sponsorTreatment'),
    });
  }
  if (args.wait) {
    const deadline = Date.now() + 10 * 60 * 1000;
    while (['queued', 'rendering'].includes(result.job?.state) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      result = await api.get(`${base}/${enc(result.job.id)}`);
    }
  }
  if (!args.json) {
    io.print(`Banner ${result.job.id}: ${result.job.state}${result.job.error ? ` (${result.job.error})` : ''}`);
    if (result.job.artifactId) io.print(`Card artifact: ${result.job.artifactId}. Download with dataops artifacts download ${result.job.artifactId}. Review before approving or publishing.`);
    else io.print(`Check: dataops cards banner ${cardId} --job ${result.job.id} --wait`);
  }
  if (result.job?.state === 'failed') throw new UsageError(`Banner job failed: ${result.job.error}. Retry the original request with the same revision after correcting the cause.`);
  return result;
}
