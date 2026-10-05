export function createWorkspaceState(context) {
  const {
    emptyOperationsAssistantSnapshot,
    emptyOperationsDocsSnapshot,
    emptyOperationsQualitySnapshot,
    emptyOperationsRecurringSnapshot,
    emptyOperationsReviewSnapshot,
    emptyOperationsWorkSnapshot,
    getAccountIdentityState,
    getWorkspaceEntityState,
    setWorkspaceEntityState,
  } = context;

  const knowledgeState = {
    allDocuments: [],
    visibleDocuments: [],
    selectedFolder: "",
    documentFilters: { domain: "", type: "", system: "", tag: "" },
    documentIdMap: new Map(),
    searchController: null,
    activeSearchSources: [],
    docReturnContext: null,
  };
  const documentState = {
    currentDoc: null,
    currentParsed: null,
    currentWarnings: [],
    lastSavedContent: "",
    hasDraft: false,
  };

  let workSnapshot = emptyOperationsWorkSnapshot();
  let recurringSnapshot = emptyOperationsRecurringSnapshot();
  let assistantSnapshot = emptyOperationsAssistantSnapshot();
  let qualitySnapshot = emptyOperationsQualitySnapshot();
  let reviewSnapshot = emptyOperationsReviewSnapshot();
  // Docs availability starts as `loading`: the bootstrap `GET /docs` has not
  // answered yet, and a pending request is not an outage.
  let docsSnapshot = emptyOperationsDocsSnapshot();
  let assistantMutation = {
    target: "",
    action: "",
    values: {},
    error: "",
    busy: false,
    status: "",
    phase: "idle",
    routeToken: 0,
  };
  let assistantQueue = { filter: "all", selectedJobId: null };
  let qualityFilters = {
    severity: "",
    category: "",
    workflow: "",
    document: "",
  };
  let activeWorkspaceView = "tasks";
  let activeTasksSection = "queue";

  // The work model is shared by Tasks, Process Docs, Admin, and the task
  // panel, so its state is named for the model rather than for whichever
  // surface happens to be on screen.
  const workModelState = {
    get workSnapshot() {
      return workSnapshot;
    },
    set workSnapshot(snapshot) {
      workSnapshot = snapshot;
    },
    get recurringSnapshot() {
      return recurringSnapshot;
    },
    get qualitySnapshot() {
      return qualitySnapshot;
    },
    set qualitySnapshot(snapshot) {
      qualitySnapshot = snapshot;
    },
    get docsSnapshot() {
      return docsSnapshot;
    },
    get accountIdentity() {
      return getAccountIdentityState();
    },
  };

  const workDetailState = {
    get workSnapshot() {
      return workSnapshot;
    },
    set workSnapshot(snapshot) {
      workSnapshot = snapshot;
    },
    get qualitySnapshot() {
      return qualitySnapshot;
    },
    get assistantSnapshot() {
      return assistantSnapshot;
    },
    get workspaceEntity() {
      return getWorkspaceEntityState();
    },
    set workspaceEntity(snapshot) {
      setWorkspaceEntityState(snapshot);
    },
  };

  const tasksSurfaceState = {
    get workSnapshot() {
      return workSnapshot;
    },
    get recurringSnapshot() {
      return recurringSnapshot;
    },
    get qualitySnapshot() {
      return qualitySnapshot;
    },
  };

  const operationsSurfaceState = {
    get workSnapshot() {
      return workSnapshot;
    },
    get assistantSnapshot() {
      return assistantSnapshot;
    },
    set assistantSnapshot(snapshot) {
      assistantSnapshot = snapshot;
    },
    get assistantMutation() {
      return assistantMutation;
    },
    set assistantMutation(snapshot) {
      assistantMutation = snapshot;
    },
    get assistantQueue() {
      return assistantQueue;
    },
    set assistantQueue(snapshot) {
      assistantQueue = snapshot;
    },
    get workspaceEntity() {
      return getWorkspaceEntityState();
    },
    set workspaceEntity(snapshot) {
      setWorkspaceEntityState(snapshot);
    },
  };

  const qualityFiltersState = {
    get value() {
      return qualityFilters;
    },
    set value(filters) {
      qualityFilters = filters;
    },
    // Mobile keeps the quality filters in a disclosure; the surface rebuilds
    // on every filter change, so the open state survives here.
    disclosureOpen: false,
  };

  const reviewSurfaceState = {
    get reviewSnapshot() {
      return reviewSnapshot;
    },
    set reviewSnapshot(snapshot) {
      reviewSnapshot = snapshot;
    },
  };

  return {
    documentState,
    knowledgeState,
    operationsSurfaceState,
    qualityFiltersState,
    reviewSurfaceState,
    tasksSurfaceState,
    workDetailState,
    workModelState,
    get activeTasksSection() {
      return activeTasksSection;
    },
    set activeTasksSection(section) {
      activeTasksSection = section;
    },
    get activeWorkspaceView() {
      return activeWorkspaceView;
    },
    set activeWorkspaceView(view) {
      activeWorkspaceView = view;
    },
    get assistantQueue() {
      return assistantQueue;
    },
    set assistantQueue(snapshot) {
      assistantQueue = snapshot;
    },
    get assistantSnapshot() {
      return assistantSnapshot;
    },
    set assistantSnapshot(snapshot) {
      assistantSnapshot = snapshot;
    },
    get assistantMutation() {
      return assistantMutation;
    },
    set assistantMutation(snapshot) {
      assistantMutation = snapshot;
    },
    get docsSnapshot() {
      return docsSnapshot;
    },
    set docsSnapshot(snapshot) {
      docsSnapshot = snapshot;
    },
    get qualityFilters() {
      return qualityFilters;
    },
    set qualityFilters(filters) {
      qualityFilters = filters;
    },
    get qualitySnapshot() {
      return qualitySnapshot;
    },
    set qualitySnapshot(snapshot) {
      qualitySnapshot = snapshot;
    },
    get reviewSnapshot() {
      return reviewSnapshot;
    },
    set reviewSnapshot(snapshot) {
      reviewSnapshot = snapshot;
    },
    get recurringSnapshot() {
      return recurringSnapshot;
    },
    set recurringSnapshot(snapshot) {
      recurringSnapshot = snapshot;
    },
    get workSnapshot() {
      return workSnapshot;
    },
    set workSnapshot(snapshot) {
      workSnapshot = snapshot;
    },
  };
}
