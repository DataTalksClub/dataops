export const DEFAULT_COLLECTION_LIMIT = 100;
export const MAX_COLLECTION_LIMIT = 200;

function normalizeLimit(limit) {
  const value = Math.trunc(Number(limit ?? DEFAULT_COLLECTION_LIMIT));
  if (!Number.isFinite(value) || value < 1) {
    return DEFAULT_COLLECTION_LIMIT;
  }
  return Math.min(value, MAX_COLLECTION_LIMIT);
}

function defaultItemKey(item) {
  return item?.id === undefined || item?.id === null ? null : String(item.id);
}

function collectionItems(payload, collection) {
  const domain = payload?.[collection];
  if (!domain || typeof domain !== "object" || Array.isArray(domain)) {
    throw new Error(`${collection} collection response was invalid`);
  }
  if (!Array.isArray(domain.items)) {
    throw new Error(`${collection} collection response was invalid`);
  }

  const nextCursor = domain.nextCursor;
  if (
    nextCursor !== undefined &&
    nextCursor !== null &&
    typeof nextCursor !== "string"
  ) {
    throw new Error(`${collection} collection response was invalid`);
  }
  return {
    items: domain.items,
    nextCursor: nextCursor || "",
  };
}

function errorMessage(error) {
  return error?.message || "Collection request failed";
}

/**
 * Accumulate a paginated API collection independently of any surface.
 *
 * `createUrl` receives `{ limit, cursor }`; cursor is omitted for the first
 * page. Keeping URL construction with the caller lets each route preserve its
 * own authenticated base URL and collection-specific filters.
 */
export function createCollectionLoader({
  request,
  createUrl,
  collection,
  itemKey = defaultItemKey,
  limit,
}) {
  if (typeof request !== "function") {
    throw new TypeError("A request function is required");
  }
  if (typeof createUrl !== "function") {
    throw new TypeError("A createUrl function is required");
  }
  if (!collection || typeof collection !== "string") {
    throw new TypeError("A collection name is required");
  }
  if (typeof itemKey !== "function") {
    throw new TypeError("itemKey must be a function");
  }

  const pageLimit = normalizeLimit(limit);
  let generation = 0;
  let activeRequest = null;
  let state = {
    items: [],
    cursor: "",
    limit: pageLimit,
    loaded: false,
    loading: false,
    loadingMore: false,
    moreAvailable: false,
    complete: false,
    failed: false,
    error: "",
  };

  function snapshot() {
    return { ...state, items: [...state.items] };
  }

  function whenSettled() {
    return state.loading || state.loadingMore
      ? activeRequest
      : Promise.resolve(snapshot());
  }

  function startInitialLoad() {
    generation += 1;
    state = {
      items: [],
      cursor: "",
      limit: pageLimit,
      loaded: false,
      loading: true,
      loadingMore: false,
      moreAvailable: false,
      complete: false,
      failed: false,
      error: "",
    };
    return fetchPage("loading", generation);
  }

  async function load() {
    if (state.loading || state.loadingMore) {
      generation += 1;
    }
    return startInitialLoad();
  }

  async function loadMore() {
    if (!state.cursor || state.complete) return snapshot();
    if (state.loading || state.loadingMore) return activeRequest;
    return fetchPage("loadingMore", generation);
  }

  function requestFailed(error, kind, requestGeneration) {
    if (requestGeneration !== generation) return;
    state = {
      ...state,
      loading: false,
      loadingMore: false,
      failed: true,
      error: errorMessage(error),
      // An interrupted initial request has no truthful prior page to keep.
      moreAvailable: kind === "loadingMore",
    };
    activeRequest = null;
  }

  async function fetchPage(kind, requestGeneration) {
    const parameters = { limit: pageLimit };
    if (kind === "loadingMore") {
      parameters.cursor = state.cursor;
      state = { ...state, loadingMore: true };
    }

    activeRequest = (async () => {
      try {
        const payload = await request(createUrl(parameters));
        if (requestGeneration !== generation) return snapshot();

        const page = collectionItems(payload, collection);
        const seen = new Set(state.items.map(itemKey));
        const items = [...state.items];
        for (const item of page.items) {
          const key = itemKey(item);
          if (key !== null && key !== undefined) {
            const identity = String(key);
            if (seen.has(identity)) continue;
            seen.add(identity);
          }
          items.push(item);
        }

        state = {
          items,
          cursor: page.nextCursor,
          limit: pageLimit,
          loaded: true,
          loading: false,
          loadingMore: false,
          moreAvailable: Boolean(page.nextCursor),
          complete: !page.nextCursor,
          failed: false,
          error: "",
        };
        activeRequest = null;
        return snapshot();
      } catch (error) {
        requestFailed(error, kind, requestGeneration);
        return snapshot();
      }
    })();

    return activeRequest;
  }

  return { load, loadMore, getSnapshot: snapshot, whenSettled };
}
