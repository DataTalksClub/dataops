import { MAX_X_POST_CHARS, splitSponsorXThread } from "./sponsor-doc-email-card.js";

/** How a thread is stored in the doc's `twitterPost` field (unchanged, so existing docs and previews keep working). */
export const X_THREAD_SEPARATOR = "\n\n---\n\n";

export function joinSponsorXThread(posts) {
  return posts.map((post) => String(post || "").trim()).filter(Boolean).join(X_THREAD_SEPARATOR);
}

/**
 * The X (Twitter) post as one editable card per tweet, each with its own
 * 280-character counter and add/remove/reorder controls, instead of one
 * textarea with "---" separators. The stored value stays the separator-joined
 * text; the separator is never shown.
 *
 * Returns a binding shaped like the other social fields' ({ control, updateCount })
 * so the auto-generated thread can replace the cards.
 */
export function mountSponsorXThreadEditor({ el, fieldWrap, fieldDef, inputId, draftContent, busy, onChange }) {
  let posts = splitSponsorXThread(draftContent[fieldDef.key]);
  if (posts.length === 0) posts = [""];

  const list = el("div", "sponsor-x-thread");
  list.dataset.sponsorXThread = "";
  const addBtn = el("button", "dk-button dk-button--secondary dk-button--sm", "Add tweet");
  addBtn.type = "button";
  addBtn.dataset.sponsorXAdd = "";
  addBtn.disabled = busy;

  const commit = () => {
    draftContent[fieldDef.key] = joinSponsorXThread(posts);
    onChange?.(draftContent[fieldDef.key]);
  };

  const smallBtn = (text, label, control, onClick, disabled) => {
    const button = el("button", "dk-button dk-button--secondary dk-button--sm sponsor-x-thread__move", text);
    button.type = "button";
    button.dataset.sponsorXControl = control;
    button.setAttribute("aria-label", label);
    button.disabled = busy || disabled;
    button.addEventListener("click", onClick);
    return button;
  };

  function renderCards() {
    list.replaceChildren();
    posts.forEach((text, index) => {
      const card = el("div", "sponsor-x-thread__card");
      card.dataset.sponsorXTweetCard = String(index + 1);
      const top = el("div", "sponsor-doc-field__top");
      const count = el("span", "sponsor-doc-field__count", `${text.length} / ${MAX_X_POST_CHARS}`);
      count.dataset.sponsorXTweetCount = String(index + 1);
      const over = text.length > MAX_X_POST_CHARS;
      if (over) count.classList.add("is-over");
      const controls = el("span", "sponsor-x-thread__controls");
      controls.append(
        smallBtn("↑", `Move tweet ${index + 1} up`, `up-${index + 1}`, () => move(index, -1), index === 0),
        smallBtn("↓", `Move tweet ${index + 1} down`, `down-${index + 1}`, () => move(index, 1), index === posts.length - 1),
        smallBtn("Remove", `Remove tweet ${index + 1}`, `remove-${index + 1}`, () => remove(index), posts.length === 1),
      );
      top.append(el("span", "sponsor-x-thread__label", posts.length > 1 ? `Tweet ${index + 1} of ${posts.length}` : "Tweet"), count, controls);

      const area = el("textarea", "dk-textarea sponsor-doc-textarea");
      area.rows = 4;
      area.id = index === 0 ? inputId : `${inputId}-${index + 1}`;
      area.value = text;
      area.disabled = busy;
      area.dataset.sponsorXTweet = String(index + 1);
      area.setAttribute("aria-label", `Tweet ${index + 1}`);
      if (over) area.setAttribute("aria-invalid", "true");
      area.addEventListener("input", () => {
        posts[index] = area.value;
        count.textContent = `${area.value.length} / ${MAX_X_POST_CHARS}`;
        const isOver = area.value.length > MAX_X_POST_CHARS;
        count.classList.toggle("is-over", isOver);
        if (isOver) area.setAttribute("aria-invalid", "true");
        else area.removeAttribute("aria-invalid");
        commit();
      });
      card.append(top, area);
      list.append(card);
    });
  }

  function move(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= posts.length) return;
    [posts[index], posts[target]] = [posts[target], posts[index]];
    renderCards();
    commit();
  }

  function remove(index) {
    if (posts.length === 1) return;
    posts.splice(index, 1);
    renderCards();
    commit();
  }

  addBtn.addEventListener("click", () => {
    posts.push("");
    renderCards();
    commit();
  });

  renderCards();
  fieldWrap.append(list, addBtn);

  return {
    control: {
      set value(next) {
        posts = splitSponsorXThread(next);
        if (posts.length === 0) posts = [""];
        renderCards();
      },
      get value() {
        return joinSponsorXThread(posts);
      },
    },
    updateCount: () => {},
  };
}
