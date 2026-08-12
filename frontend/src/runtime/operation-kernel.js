import {
  createOperationsModel,
  labelizeWorkValue,
} from "../core/operations-model.js";
import { createOperationsOverview } from "../surfaces/operations-overview.js";

export function createOperationKernel(context) {
  const {
    basename,
    cleanPath,
    documentRef,
    getRecurringConfigTitle,
    openBundlePanel,
    openDocument,
    openTaskPanel,
    resolveAssigneeLabel,
    resolveDocReference,
    showWorkspaceSurface,
    tasksSectionTitle,
    workspaceState,
  } = context;
  const model = createOperationsModel({
    basename,
    cleanPath,
    getRecurringConfigTitle,
    resolveAssigneeLabel,
  });
  const overview = createOperationsOverview({
    document: documentRef,
    labelizeWorkValue,
    openBundlePanel,
    openDocument,
    openTaskPanel,
    resolveDocReference,
    showWorkspaceSurface,
    state: workspaceState.overviewState,
    tasksSectionTitle,
  });
  return { ...model, ...overview };
}
