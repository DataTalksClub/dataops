export function createArtifactsSurface(context) {
  const {
    assistantJobsFromPayload,
    clearSelectionButton,
    cssEscape,
    dedupeArtifacts,
    defaultNextFollowUpDate,
    documentList,
    escapeHtml,
    getActiveWorkspaceRoute,
    getActiveWorkspaceView,
    isOperationsHomeVisible,
    isMobileShell,
    isWorkspaceRouteFresh,
    libraryTitle,
    navigateCanonicalWorkspace,
    openCardPanel,
    openTaskPanel,
    promptUser,
    refreshDocuments,
    renderEntityLoadState,
    renderHonestState,
    reportError,
    request,
    scheduleAnimationFrame,
    setRouteTitle,
    setStatus,
    showCreate,
    state,
    tasksFromWorkPayload,
    todayIsoDate,
    workApiUrl,
    workTaskTitle,
  } = context;

  function normalizeArtifactUrl(value) {
    if (typeof value !== "string") return "";
    return value
      .trim()
      .replace(
        /(?:%20|\s)(?:%22|")(?:%E2%80%8C|\u200c)(?:%22|")$/iu,
        "",
      );
  }

  function renderArtifactsSurface() {
    const section = document.createElement("section");
    section.className = "ops-state-list";
    section.setAttribute("aria-label", "Artifacts");
    if (!state.artifactSnapshot.loaded) {
      section.append(
        renderHonestState(
          "Artifact review index not connected",
          "Task and Card panels still show artifacts loaded in context. This surface will list proof and output across Cards when the artifact index is available.",
        ),
      );
      return section;
    }
    if (state.artifactSnapshot.artifacts.length === 0) {
      section.append(
        renderHonestState(
          "No artifacts registered",
          "There are no artifact rows to review. No generated assistant outputs or proof links are being invented.",
        ),
      );
      return section;
    }
    for (const artifact of state.artifactSnapshot.artifacts)
      section.append(renderArtifactSurfaceRow(artifact));
    return section;
  }

  function renderArtifactSurfaceRow(artifact) {
    const row = document.createElement("article");
    row.className = "ops-data-row";
    const storageUri = normalizeArtifactUrl(artifact.storageUri);
    const artifactLabel =
      artifact.title || storageUri || artifact.id || "Artifact";
    const title = document.createElement("strong");
    title.textContent = artifactLabel;
    const meta = document.createElement("span");
    meta.textContent = [
      artifact.status || "draft",
      artifact.type || artifact.sourceType || "",
      artifact.cardId ? `card ${artifact.cardId}` : "",
      artifact.taskId ? `task ${artifact.taskId}` : "",
      artifact.storageUri ? "storage linked" : "storage missing",
    ]
      .filter(Boolean)
      .join(" · ");
    row.append(title, meta);
    if (storageUri) {
      const link = document.createElement("a");
      link.href = storageUri;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = "Open artifact";
      const linkContext = [
        artifact.cardId ? `card ${artifact.cardId}` : "",
        artifact.taskId ? `task ${artifact.taskId}` : "",
      ]
        .filter(Boolean)
        .join(", ");
      link.setAttribute(
        "aria-label",
        `Open ${artifactLabel}${
          linkContext ? ` for ${linkContext}` : ""
        }`,
      );
      row.append(link);
    }
    return row;
  }

  async function refreshOperationsArtifactSnapshot(options = {}) {
    const snapshot = {
      loaded: false,
      artifacts: [],
      errors: [],
    };
    try {
      const payload = await request(workApiUrl("/api/artifacts"));
      const artifacts = Array.isArray(payload) ? payload : payload?.artifacts;
      if (Array.isArray(artifacts)) {
        snapshot.loaded = true;
        snapshot.artifacts = artifacts;
      } else {
        snapshot.errors = [
          "Artifact review index is not connected in this environment.",
        ];
      }
    } catch (err) {
      snapshot.errors = [err?.message || "Artifacts API request failed"];
    }
    state.artifactSnapshot = {
      loaded: snapshot.loaded,
      artifacts: dedupeArtifacts(snapshot.artifacts),
      errors: snapshot.errors,
    };
    if (options.rerender && isOperationsHomeVisible()) refreshDocuments();
  }

  return {
    refreshOperationsArtifactSnapshot,
    renderArtifactsSurface,
  };
}
