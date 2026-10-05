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
    openCardPanel,
    openDocument,
    openTaskPanel,
    resolveAssigneeLabel,
    resolveDocReference,
    showWorkspaceSurface,
    tasksSectionTitle,
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
    openCardPanel,
    openDocument,
    openTaskPanel,
    resolveDocReference,
    showWorkspaceSurface,
    tasksSectionTitle,
  });
  return { ...model, ...overview };
}
