import { createBookkeepingSurface } from "./bookkeeping.js";
import { createFinanceOverviewSurface } from "./overview.js";
import { createSponsorCrmSurface } from "./sponsors.js";
import "./bookkeeping-statement.js";
import "./bookkeeping-transaction-dialog.js";

export function createFinanceSurface(context) {
  const bookkeeping = createBookkeepingSurface(context);
  const sponsors = createSponsorCrmSurface(context);
  const overview = createFinanceOverviewSurface(context);

  return {
    canLeaveFinanceSurface: sponsors.canLeaveFinanceSurface,
    renderBookkeepingSurface: bookkeeping.renderBookkeepingSurface,
    renderFinanceOverviewSurface: overview.renderFinanceOverviewSurface,
    renderSponsorCrmSurface: sponsors.renderSponsorCrmSurface,
  };
}
