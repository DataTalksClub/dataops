import { createBookkeepingSurface } from "./bookkeeping.js";
import { createSponsorCrmSurface } from "./sponsors.js";

export function createFinanceSurface(context) {
  const bookkeeping = createBookkeepingSurface(context);
  const sponsors = createSponsorCrmSurface(context);

  return {
    canLeaveFinanceSurface: sponsors.canLeaveFinanceSurface,
    renderBookkeepingSurface: bookkeeping.renderBookkeepingSurface,
    renderSponsorCrmSurface: sponsors.renderSponsorCrmSurface,
  };
}
