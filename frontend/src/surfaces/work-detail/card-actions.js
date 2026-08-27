export function createCardActions(context) {
  const {
    cardPanelBody,
    captureCardPanelDrafts,
    detail,
    getActiveWorkspaceRoute,
    getActiveWorkspaceRouteToken = () => 0,
    isWorkspaceRouteFresh,
    labelizeWorkValue,
    navigateCanonicalWorkspace,
    refreshOperationsWorkSnapshot,
    renderCardPanel,
    renderCardPanelRetainingDrafts,
    request,
    state,
    workApiUrl,
  } = context;

  function routeIsFresh(token) {
    return token === undefined || token === null || isWorkspaceRouteFresh(token);
  }

  function cardIsCurrent(cardId, token) {
    return routeIsFresh(token) && detail.activeCardPanelId === cardId;
  }

  function focusCardPanel() {
    const target = Array.from(
      cardPanelBody?.querySelectorAll("button, input, select, textarea") || [],
    ).find((element) => !element.disabled);
    target?.focus();
  }

  function snapshotCard(cardId) {
    const snapshot = state?.workSnapshot;
    const fromMap = snapshot?.cardsById?.get?.(cardId);
    if (fromMap) return fromMap;
    return snapshot?.cards?.find((card) => card?.id === cardId) || null;
  }

  function sameValue(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  function cardMutationMatches(card, intent, minimumVersion) {
    if (!card || typeof card !== "object" || card.id !== intent.cardId) {
      return false;
    }
    if (
      Number.isInteger(minimumVersion) &&
      Number.isInteger(card.version) &&
      card.version < minimumVersion
    ) {
      return false;
    }
    const expected = intent.kind === "stage"
      ? { stage: intent.payload.stage }
      : intent.kind === "reference"
        ? { references: intent.payload.references }
        : intent.kind === "card-link"
          ? { cardLinks: intent.payload.cardLinks }
          : {};
    return Object.entries(expected).every(([field, value]) =>
      sameValue(card[field], value),
    );
  }

  async function confirmCardMutation(
    intent,
    updatedCard,
    previousSnapshot,
    routeToken,
  ) {
    await refreshOperationsWorkSnapshot({ rerender: true });
    if (!cardIsCurrent(intent.cardId, routeToken)) return null;

    const errors = state?.workSnapshot?.errors;
    if (Array.isArray(errors) && errors.length > 0) {
      throw new Error(`Refreshed work view is incomplete: ${errors[0]}`);
    }

    const refreshedFromSnapshot = snapshotCard(intent.cardId);
    if (
      state?.workSnapshot !== previousSnapshot &&
      cardMutationMatches(refreshedFromSnapshot, intent, updatedCard.version)
    ) {
      return refreshedFromSnapshot;
    }

    // Local preview adapters may leave the shared snapshot untouched. In the
    // deployed shell a refresh replaces it, so the mutation response is only
    // used as the explicit fallback for those adapters and test doubles.
    if (state?.workSnapshot === previousSnapshot) {
      if (!cardMutationMatches(updatedCard, intent, updatedCard.version)) {
        throw new Error("Card response did not retain the requested change");
      }
      return updatedCard;
    }

    const payload = await request(
      workApiUrl(`/api/cards/${encodeURIComponent(intent.cardId)}`),
    );
    if (!cardIsCurrent(intent.cardId, routeToken)) return null;
    const refreshed = payload?.card || payload;
    if (!cardMutationMatches(refreshed, intent, updatedCard.version)) {
      throw new Error("Card refresh did not confirm the requested change");
    }
    return refreshed;
  }

  async function reloadCardTemplateUpdate(cardId) {
    const routeToken = getActiveWorkspaceRouteToken();
    if (!cardIsCurrent(cardId, routeToken)) return;
    const drafts = captureCardPanelDrafts();
    detail.activeCardTemplateBusy = true;
    detail.activeCardTemplateMessage = "";
    renderCardPanelRetainingDrafts(drafts);
    try {
      const response = await request(
        workApiUrl(`/api/cards/${encodeURIComponent(cardId)}/template-update`),
      );
      if (!cardIsCurrent(cardId, routeToken)) return;
      detail.activeCardPanelData = {
        ...detail.activeCardPanelData,
        templateUpdate: response?.preview || response,
        templateUpdateError: "",
      };
      detail.activeCardTemplateReviewOpen = true;
    } catch (error) {
      if (cardIsCurrent(cardId, routeToken)) {
        detail.activeCardTemplateMessage =
          error.message || "Could not reload the latest preview.";
      }
    } finally {
      if (cardIsCurrent(cardId, routeToken)) {
        detail.activeCardTemplateBusy = false;
        renderCardPanelRetainingDrafts(drafts);
      }
    }
  }

  async function applyCardTemplateUpdate(cardId, previewToken) {
    const routeToken = getActiveWorkspaceRouteToken();
    if (!cardIsCurrent(cardId, routeToken)) return;
    const drafts = captureCardPanelDrafts();
    detail.activeCardTemplateBusy = true;
    detail.activeCardTemplateMessage = "";
    renderCardPanelRetainingDrafts(drafts);
    try {
      const response = await request(
        workApiUrl(`/api/cards/${encodeURIComponent(cardId)}/template-update`),
        { method: "POST", body: JSON.stringify({ previewToken }) },
      );
      if (!cardIsCurrent(cardId, routeToken)) return;
      detail.activeCardPanelData = {
        ...detail.activeCardPanelData,
        card: response.card || detail.activeCardPanelData.card,
        tasks: Array.isArray(response.tasks)
          ? response.tasks
          : detail.activeCardPanelData.tasks,
      };
      const latest = await request(
        workApiUrl(`/api/cards/${encodeURIComponent(cardId)}/template-update`),
      );
      if (!cardIsCurrent(cardId, routeToken)) return;
      detail.activeCardPanelData.templateUpdate = latest?.preview || latest;
      detail.activeCardTemplateReviewOpen = false;
      detail.activeCardTemplateMessage = "";
      await refreshOperationsWorkSnapshot({ rerender: true });
      if (!cardIsCurrent(cardId, routeToken)) return;
    } catch (error) {
      if (cardIsCurrent(cardId, routeToken)) {
        detail.activeCardTemplateMessage = error.status === 409
          ? "Card, Task, or Template changed after preview. Your review is retained; reload the latest preview when ready."
          : `Could not apply Template update: ${error.message || "request failed"}`;
      }
    } finally {
      if (cardIsCurrent(cardId, routeToken)) {
        detail.activeCardTemplateBusy = false;
        renderCardPanelRetainingDrafts(drafts);
      }
    }
  }

  async function submitCardIntent(intent, expectedVersion) {
    const routeToken = getActiveWorkspaceRouteToken();
    if (
      detail.activeCardMutationBusy ||
      detail.activeTaskMutationBusy ||
      detail.activeCardTemplateBusy
    ) return null;
    if (!cardIsCurrent(intent.cardId, routeToken)) return null;
    intent.entity = "card";
    intent.expectedVersion = expectedVersion;
    detail.activeCardPanelDraft = intent;
    detail.activeCardMutationBusy = true;
    detail.activeCardPanelFeedback = {
      owner: "card",
      phase: "pending",
      message: intent.pendingMessage || `${intent.label}…`,
      intent,
    };
    renderCardPanel();
    try {
      const currentCard = detail.activeCardPanelConflict?.currentCard ||
        detail.activeCardPanelData?.card;
      const payload = intent.buildPayload
        ? intent.buildPayload(currentCard)
        : intent.payload;
      intent.payload = payload;
      detail.activeCardPanelConflict = null;
      renderCardPanel({ preserveDrafts: true });
      const response = await request(
        workApiUrl(`/api/cards/${encodeURIComponent(intent.cardId)}`),
        {
          method: "PUT",
          body: JSON.stringify({ ...intent.payload, expectedVersion }),
        },
      );
      const updatedCard = response && (response.card || response);
      if (!updatedCard?.id || updatedCard.id !== intent.cardId) {
        throw new Error("Card response is not in the canonical versioned shape");
      }
      if (
        !routeIsFresh(routeToken) ||
        detail.activeCardPanelId !== intent.cardId
      ) {
        return null;
      }
      if (updatedCard && detail.activeCardPanelId === intent.cardId) {
        detail.activeCardPanelData = {
          ...detail.activeCardPanelData,
          card: updatedCard,
        };
        renderCardPanel({ preserveDrafts: true });
      }
      const confirmed = await confirmCardMutation(
        intent,
        updatedCard,
        state?.workSnapshot,
        routeToken,
      );
      if (!confirmed || !cardIsCurrent(intent.cardId, routeToken)) {
        return null;
      }
      detail.activeCardPanelData = {
        ...detail.activeCardPanelData,
        card: confirmed,
      };
      detail.activeCardPanelDraft = null;
      detail.activeCardPanelConflict = null;
      detail.activeCardPanelFeedback = null;
      detail.activeCardMutationBusy = false;
      detail.activeCardPanelFeedback = {
        owner: "card",
        phase: "success",
        message:
          intent.successMessage ||
          `${intent.label} is confirmed in the refreshed Card.`,
      };
      renderCardPanel();
      return confirmed;
    } catch (error) {
      if (
        !routeIsFresh(routeToken) ||
        detail.activeCardPanelId !== intent.cardId
      ) {
        return null;
      }
      detail.activeCardMutationBusy = false;
      if (
        error?.status === 409 &&
        error?.code === "card_version_conflict" &&
        error?.payload?.currentCard?.id === intent.cardId
      ) {
        detail.activeCardPanelConflict = error.payload;
        detail.activeCardPanelFeedback = null;
        renderCardPanel();
        return null;
      }
      detail.activeCardPanelFeedback = {
        owner: "card",
        phase: "error",
        message: `${intent.errorPrefix}: ${error.message || "request failed"}`,
        intent,
      };
      renderCardPanel();
      return null;
    }
  }

  function reviewLatestCard() {
    const latest = detail.activeCardPanelConflict?.currentCard;
    if (!latest) return;
    detail.activeCardPanelData = {
      ...detail.activeCardPanelData,
      card: latest,
    };
    renderCardPanel();
  }

  async function retryCardIntent() {
    const intent = detail.activeCardPanelDraft;
    const latest = detail.activeCardPanelConflict?.currentCard;
    if (!intent) return;
    await submitCardIntent(intent, latest?.version || intent.expectedVersion);
  }

  function discardCardIntent() {
    const latest = detail.activeCardPanelConflict?.currentCard;
    if (latest) {
      detail.activeCardPanelData = {
        ...detail.activeCardPanelData,
        card: latest,
      };
    }
    detail.activeCardPanelDraft = null;
    detail.activeCardPanelConflict = null;
    detail.activeCardPanelFeedback = null;
    renderCardPanel();
    focusCardPanel();
  }

  function reloadCardIntent() {
    detail.activeCardPanelDraft = null;
    detail.activeCardPanelConflict = null;
    detail.activeCardPanelFeedback = null;
    detail.activeCardMutationBusy = false;
    detail.activeTaskPanelDraft = null;
    detail.activeTaskPanelConflict = null;
    detail.activeTaskPanelFeedback = null;
    detail.activeTaskMutationBusy = false;
    const route = getActiveWorkspaceRoute?.();
    if (!route || route.invalid) return undefined;
    return navigateCanonicalWorkspace(route.path, route.params, {
      history: "none",
    }).ready;
  }

  async function addCardReference(cardId, currentRefs, name, url) {
    if (!url) {
      detail.activeCardPanelDraft = {
        cardId,
        kind: "reference",
        label: "Add reference",
        form: { name, url },
        payload: { references: currentRefs || [] },
      };
      detail.activeCardPanelFeedback = {
        owner: "card",
        phase: "error",
        message: "URL is required.",
        focusSelector: ".card-ref-url",
      };
      renderCardPanel();
      return;
    }
    const ref = { name: name || url, url };
    const updatedRefs = [...(currentRefs || []), ref];
    await submitCardIntent(
      {
        cardId,
        kind: "reference",
        label: `Add reference ${ref.name}`,
        payload: { references: updatedRefs },
        buildPayload: (currentCard) => ({
          references: [...(currentCard?.references || []), ref],
        }),
        form: { name, url },
        pendingMessage: "Adding the Card reference…",
        successMessage: "Card reference is saved in the refreshed Card.",
        errorPrefix: "Could not add link",
      },
      detail.activeCardPanelData?.card?.version,
    );
  }

  async function updateCardStage(cardId, stage) {
    await submitCardIntent(
      {
        cardId,
        kind: "stage",
        label: `Set stage to ${labelizeWorkValue(stage)}`,
        payload: { stage },
        pendingMessage: "Saving the Card stage…",
        successMessage: "Card stage is saved in the refreshed Card.",
        errorPrefix: "Could not update stage",
      },
      detail.activeCardPanelData?.card?.version,
    );
  }

  async function saveCardLink(cardId, currentLinks, linkName, linkValue) {
    const updatedLinks = (currentLinks || []).map((link) =>
      (link.name || link.label) === linkName
        ? { ...link, url: linkValue }
        : link,
    );
    await submitCardIntent(
      {
        cardId,
        kind: "card-link",
        label: `Save ${linkName}: ${linkValue}`,
        payload: { cardLinks: updatedLinks },
        buildPayload: (currentCard) => ({
          cardLinks: (currentCard?.cardLinks || []).map((link) =>
            (link.name || link.label) === linkName
              ? { ...link, url: linkValue }
              : link,
          ),
        }),
        pendingMessage: "Saving the Card link…",
        successMessage: "Card link is saved in the refreshed Card.",
        errorPrefix: "Could not save link",
      },
      detail.activeCardPanelData?.card?.version,
    );
  }

  return {
    addCardReference,
    applyCardTemplateUpdate,
    discardCardIntent,
    reloadCardIntent,
    reloadCardTemplateUpdate,
    retryCardIntent,
    reviewLatestCard,
    saveCardLink,
    submitCardIntent,
    updateCardStage,
  };
}
