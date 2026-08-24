export function createWorkspaceState(context) {
  const {
    emptyOperationsArtifactSnapshot,
    emptyOperationsAssistantSnapshot,
    emptyOperationsDocsSnapshot,
    emptyOperationsQualitySnapshot,
    emptyOperationsRecurringSnapshot,
    emptyOperationsWorkSnapshot,
    getAccountIdentityState,
    getWorkspaceEntityState,
    setWorkspaceEntityState,
  } = context;

  const knowledgeState = {
    allDocuments: [],
    visibleDocuments: [],
    selectedFolder: "",
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
  let artifactSnapshot = emptyOperationsArtifactSnapshot();
  let assistantSnapshot = emptyOperationsAssistantSnapshot();
  let qualitySnapshot = emptyOperationsQualitySnapshot();
  // Docs availability starts as `loading`: the bootstrap `GET /docs` has not
  // answered yet, and a pending request is not an outage.
  let docsSnapshot = emptyOperationsDocsSnapshot();
  let intake = {
    filter: "actionable",
    selectedId: null,
    items: [],
    cards: [],
    loaded: false,
    error: "",
  };
  let intakeMutation = {
    itemId: "",
    action: "",
    values: {},
    focus: null,
    error: "",
    busy: false,
    status: "",
  };
  let assistantQueue = { filter: "podcast", selectedJobId: null };
  let qualityFilters = {
    severity: "",
    category: "",
    workflow: "",
    document: "",
  };
  let activeWorkspaceView = "home";
  let activeTasksSection = "queue";

  const homeSurfaceState = {
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
    get artifactSnapshot() {
      return artifactSnapshot;
    },
    set artifactSnapshot(snapshot) {
      artifactSnapshot = snapshot;
    },
    get assistantSnapshot() {
      return assistantSnapshot;
    },
    set assistantSnapshot(snapshot) {
      assistantSnapshot = snapshot;
    },
    get intake() {
      return intake;
    },
    set intake(snapshot) {
      intake = snapshot;
    },
    get intakeMutation() {
      return intakeMutation;
    },
    set intakeMutation(snapshot) {
      intakeMutation = snapshot;
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

  const overviewState = {
    get artifactSnapshot() {
      return artifactSnapshot;
    },
    get assistantSnapshot() {
      return assistantSnapshot;
    },
    get qualitySnapshot() {
      return qualitySnapshot;
    },
  };

  const qualityFiltersState = {
    get value() {
      return qualityFilters;
    },
    set value(filters) {
      qualityFilters = filters;
    },
  };

  return {
    documentState,
    homeSurfaceState,
    knowledgeState,
    operationsSurfaceState,
    overviewState,
    qualityFiltersState,
    tasksSurfaceState,
    workDetailState,
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
    get artifactSnapshot() {
      return artifactSnapshot;
    },
    set artifactSnapshot(snapshot) {
      artifactSnapshot = snapshot;
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
    get docsSnapshot() {
      return docsSnapshot;
    },
    set docsSnapshot(snapshot) {
      docsSnapshot = snapshot;
    },
    get intake() {
      return intake;
    },
    set intake(snapshot) {
      intake = snapshot;
    },
    get intakeMutation() {
      return intakeMutation;
    },
    set intakeMutation(snapshot) {
      intakeMutation = snapshot;
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
