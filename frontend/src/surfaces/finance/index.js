import { createBookkeepingSurface } from "./bookkeeping.js";
import { createFinanceOverviewSurface } from "./overview.js";
import { createInventorySurface } from "./inventory.js";
import { createSponsorCrmSurface } from "./sponsors.js";
import "./bookkeeping-statement.js";
import "./bookkeeping-transaction-dialog.js";
import "./bookkeeping-transaction-modal.js";

export function createFinanceSurface(context) {
  const bookkeeping = createBookkeepingSurface(context);
  const inventory = createInventorySurface(context);
  const sponsors = createSponsorCrmSurface(context);
  const overview = createFinanceOverviewSurface(context);

  return {
    canLeaveFinanceSurface: sponsors.canLeaveFinanceSurface,
    renderBookkeepingSurface: bookkeeping.renderBookkeepingSurface,
    renderFinanceOverviewSurface: overview.renderFinanceOverviewSurface,
    renderInventorySurface: inventory.renderInventorySurface,
    renderSponsorCrmSurface: sponsors.renderSponsorCrmSurface,
  };
}
