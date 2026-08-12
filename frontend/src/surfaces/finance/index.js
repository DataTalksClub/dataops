import { createBookkeepingSurface } from "./bookkeeping.js";
import { createMailingExportsSurface } from "./mailing.js";
import { createSponsorCrmSurface } from "./sponsors.js";

export function createFinanceSurface(context) {
  const bookkeeping = createBookkeepingSurface(context);
  const mailing = createMailingExportsSurface(context);
  const sponsors = createSponsorCrmSurface(context);

  return {
    canLeaveFinanceSurface: sponsors.canLeaveFinanceSurface,
    renderBookkeepingSurface: bookkeeping.renderBookkeepingSurface,
    renderMailingExportsSurface: mailing.renderMailingExportsSurface,
    renderSponsorCrmSurface: sponsors.renderSponsorCrmSurface,
  };
}
