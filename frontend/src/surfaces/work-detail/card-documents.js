import { opensInNewTab } from '../../core/links.js';
import { isEventCard, renderCardSponsorDocsSection, visibleCardDocs } from './card-summary.js';

const drafts = new Map();
const workspaces = new WeakMap();
/** Private Card workspace. Text APIs keep document content inert. */
export function renderCardDocuments({ card, request, workApiUrl }) {
  let cached = workspaces.get(request);
  if (!cached) { cached = new Map(); workspaces.set(request, cached); }
  if (cached.has(card.id)) return cached.get(card.id);
  const section = document.createElement('section');
  cached.set(card.id, section);
  if (cached.size > 20) cached.delete(cached.keys().next().value);
  section.className = 'task-documents card-docs';
  section.setAttribute('aria-label', 'Staff-only card documents');
  const heading = document.createElement('h3');
  heading.className = 'card-docs__title';
  heading.textContent = 'Staff-only documents';
  const privacy = document.createElement('p');
  privacy.className = 'dk-hint card-docs__hint';
  privacy.textContent = 'Only signed-in staff can open these documents. Guest codes do not grant access.';
  const status = document.createElement('p');
  status.className = 'dk-hint card-docs__status';
  status.setAttribute('role', 'status');
  const list = document.createElement('div');
  list.className = 'card-docs__list';
  const form = document.createElement('form');
  form.className = 'card-docs__form';
  const fields = document.createElement('div');
  fields.className = 'card-docs__fields';
  const kindField = document.createElement('div');
  kindField.className = 'card-docs__field';
  const kindLabel = document.createElement('label');
  kindLabel.className = 'dk-label';
  kindLabel.textContent = 'Document type';
  kindLabel.htmlFor = `card-docs-kind-${card.id}`;
  const kind = document.createElement('select');
  kind.id = `card-docs-kind-${card.id}`;
  kind.className = 'dk-select card-docs__select';
  kind.setAttribute('aria-label', 'Document kind');
  for (const value of ['transcript', 'timecodes', 'summary', 'note']) {
    const option = document.createElement('option'); option.value = value; option.textContent = value[0].toUpperCase() + value.slice(1); kind.append(option);
  }
  kindField.append(kindLabel, kind);
  const titleField = document.createElement('div');
  titleField.className = 'card-docs__field';
  const titleLabel = document.createElement('label');
  titleLabel.className = 'dk-label';
  titleLabel.textContent = 'Title';
  titleLabel.htmlFor = `card-docs-title-${card.id}`;
  const title = document.createElement('input');
  title.id = `card-docs-title-${card.id}`;
  title.className = 'dk-input card-docs__title-input';
  title.placeholder = 'Document title'; title.setAttribute('aria-label', 'New document title'); title.required = true; title.maxLength = 200;
  titleField.append(titleLabel, title);
  fields.append(kindField, titleField);
  const actions = document.createElement('div');
  actions.className = 'card-docs__actions';
  const create = document.createElement('button'); create.type = 'submit';
  create.className = 'dk-button dk-button--primary card-docs__create'; create.textContent = 'Create document';
  const refresh = document.createElement('button'); refresh.type = 'button';
  refresh.className = 'dk-button dk-button--secondary card-docs__refresh';
  refresh.textContent = '↻ Refresh documents'; refresh.setAttribute('aria-label', 'Refresh documents');
  refresh.addEventListener('click', () => { void load(); });
  actions.append(create, refresh);
  form.append(fields, actions);
  form.addEventListener('submit', async event => {
    event.preventDefault(); create.disabled = true;
    try {
      const result = await request(workApiUrl('/api/card-documents'), {
        method: 'POST',
        body: JSON.stringify({ cardId: card.id, kind: kind.value, title: title.value, content: '' }),
      });
      title.value = ''; await load(result.document.id); status.textContent = 'Document created.';
    } catch (error) { status.textContent = error.message || 'Could not create document.'; }
    finally { create.disabled = false; }
  });
  function editor(doc, open) {
    if (typeof doc.content !== 'string') {
      const shell = document.createElement('details');
      shell.className = 'card-docs__item';
      const summary = document.createElement('summary'); summary.className = 'card-docs__item-title'; summary.textContent = `${doc.title} · ${doc.kind}`;
      const feedback = document.createElement('p'); feedback.className = 'dk-hint card-docs__feedback'; feedback.setAttribute('role', 'status');
      shell.append(summary, feedback); shell.open = open || drafts.has(doc.id);
      let pending = false;
      shell.addEventListener('toggle', async () => {
        if (!shell.open || pending) return;
        pending = true; feedback.textContent = 'Loading document…';
        try {
          const result = await request(workApiUrl(`/api/card-documents/${encodeURIComponent(doc.id)}`));
          shell.replaceWith(editor(result.document, true));
        } catch (error) { feedback.textContent = error.message || 'Could not load document. Close and reopen to retry.'; }
        finally { pending = false; }
      });
      return shell;
    }
    const draft = drafts.get(doc.id);
    if (draft) doc = { ...doc, version: draft.version };
    const details = document.createElement('details'); details.className = 'card-docs__item'; details.open = open || !!draft;
    const summary = document.createElement('summary'); summary.className = 'card-docs__item-title'; summary.textContent = `${doc.title} · ${doc.kind}`;
    const name = document.createElement('input'); name.className = 'dk-input card-docs__rename';
    name.value = draft?.title ?? doc.title; name.maxLength = 200; name.setAttribute('aria-label', 'Document title');
    const text = document.createElement('textarea'); text.className = 'dk-textarea card-docs__editor';
    text.value = draft?.content ?? doc.content; text.rows = 16; text.setAttribute('aria-label', 'Document content');
    const remember = () => drafts.set(doc.id, { title: name.value, content: text.value, version: drafts.get(doc.id)?.version ?? doc.version });
    name.addEventListener('input', remember); text.addEventListener('input', remember);
    const save = document.createElement('button'); save.type = 'button';
    save.className = 'dk-button dk-button--primary dk-button--sm card-docs__save'; save.textContent = 'Save document';
    const feedback = document.createElement('p');
    feedback.className = 'dk-hint card-docs__feedback'; feedback.setAttribute('role', 'status');
    save.addEventListener('click', async () => {
      save.disabled = true;
      const submittedDraft = drafts.get(doc.id);
      const submitted = { title: name.value, content: text.value, version: submittedDraft?.version ?? doc.version };
      try {
        const result = await request(workApiUrl(`/api/card-documents/${encodeURIComponent(doc.id)}`), {
          method: 'PUT',
          body: JSON.stringify(submitted),
        });
        doc = result.document; summary.textContent = `${doc.title} · ${doc.kind}`;
        const latest = drafts.get(doc.id);
        const newerDraft = latest && latest !== submittedDraft;
        const newerInputs = name.value !== submitted.title || text.value !== submitted.content;
        if (newerDraft || newerInputs || !details.isConnected) {
          const retained = newerDraft ? latest : { title: name.value, content: text.value };
          drafts.set(doc.id, { ...retained, version: doc.version });
        } else { drafts.delete(doc.id); }
        feedback.textContent = newerDraft || newerInputs ? 'Saved submitted text. You have unsaved changes.' : 'Saved.';
      } catch (error) { feedback.textContent = `${error.message || 'Could not save.'} Your text is still here. Copy it before reloading if another person changed the document.`; }
      finally { save.disabled = false; }
    });
    const exports = document.createElement('div'); exports.className = 'card-docs__exports';
    const preview = document.createElement('a');
    preview.className = 'dk-button dk-button--secondary dk-button--sm';
    preview.textContent = 'Read private draft / PDF';
    preview.href = workApiUrl(`/api/card-documents/${encodeURIComponent(doc.id)}/preview`);
    preview.target = '_blank'; preview.rel = 'noreferrer noopener';
    exports.append(preview);
    for (const format of ['txt', 'docx', 'pdf']) {
      const button = document.createElement('button'); button.type = 'button';
      button.className = 'dk-button dk-button--secondary dk-button--sm'; button.textContent = `Export ${format.toUpperCase()}`;
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const blob = await request(workApiUrl(`/api/card-documents/${encodeURIComponent(doc.id)}/export?format=${format}`), { responseType: 'blob' });
          const url = URL.createObjectURL(blob); const link = document.createElement('a');
          link.href = url; link.download = `${doc.title.replace(/[^a-zA-Z0-9_-]/g, '_') || 'document'}.${format}`;
          link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
          feedback.textContent = 'Exported the saved document.';
        } catch (error) { feedback.textContent = error.message || 'Could not export document.'; }
        finally { button.disabled = false; }
      });
      exports.append(button);
    }
    const remove = document.createElement('button'); remove.type = 'button';
    remove.className = 'dk-button dk-button--sm dk-button--danger card-docs__delete'; remove.textContent = 'Delete document';
    remove.addEventListener('click', async () => {
      if (!window.confirm(`Delete “${doc.title}”?`)) return;
      remove.disabled = true;
      try {
        await request(workApiUrl(`/api/card-documents/${encodeURIComponent(doc.id)}?version=${doc.version}`), { method: 'DELETE' });
        drafts.delete(doc.id); await load();
      } catch (error) { feedback.textContent = error.message || 'Could not delete document.'; }
      finally { remove.disabled = false; }
    });
    details.append(summary, name, text, save, feedback, exports, remove);
    return details;
  }
  async function load(openId) {
    status.textContent = 'Loading documents…';
    try {
      const result = await request(workApiUrl(`/api/card-documents?cardId=${encodeURIComponent(card.id)}`));
      list.replaceChildren(...result.documents.map(doc => editor(doc, doc.id === openId)));
      status.textContent = result.documents.length ? '' : 'No documents yet. Create a transcript, timecodes, summary, or note for this card.';
    } catch (error) { status.textContent = error.message || 'Could not load documents.'; }
  }
  section.append(heading, privacy, form, status, list);
  void load();
  return section;
}

/**
 * Top-of-card quick bar for event cards:
 * - Podcast: immediate `/podcast-docs/` link (AC12) + one-click live questions preview (AC19)
 * - All event cards (podcast, webinar, workshop): optional "Sponsored" flag toggle (AC18)
 */
export function renderCardEventQuickBar({ card, request, workApiUrl, reload }) {
  if (!isEventCard(card)) return null;
  const docs = visibleCardDocs(card);
  const podcastDoc = docs.find((d) => String(d.template || '') === 'podcast');
  const podcastLinkFromCard = (card.cardLinks || []).find((l) => /\/podcast-docs\/[^/?#]+/.test(String(l.url || '')));
  const podcastDocUrl = podcastDoc
    ? `/podcast-docs/${encodeURIComponent(podcastDoc.id)}`
    : (podcastLinkFromCard?.url || '');

  const bar = document.createElement('section');
  bar.className = 'workflow-detail-section card-event-quick-bar';
  bar.dataset.cardEventQuickBar = '';

  const row = document.createElement('div');
  row.className = 'card-newsletter-slot__row';

  if (podcastDocUrl) {
    const docLink = document.createElement('a');
    docLink.href = podcastDocUrl;
    docLink.className = 'dk-button dk-button--secondary dk-button--sm';
    docLink.dataset.cardPodcastDocTopLink = '';
    docLink.textContent = 'Open Guest Document (/podcast-docs/)';
    opensInNewTab(docLink);
    row.append(docLink);
  }

  let previewPanel = null;
  if (podcastDoc || card.qna?.url) {
    const qBtn = document.createElement('button');
    qBtn.type = 'button';
    qBtn.className = 'dk-button dk-button--primary dk-button--sm';
    qBtn.dataset.cardLiveQuestionsTrigger = '';
    qBtn.textContent = 'Live questions preview';
    row.append(qBtn);

    previewPanel = document.createElement('div');
    previewPanel.className = 'card-live-questions-preview';
    previewPanel.dataset.cardLiveQuestionsPanel = '';
    previewPanel.hidden = true;

    qBtn.addEventListener('click', async () => {
      if (!previewPanel.hidden) {
        previewPanel.hidden = true;
        qBtn.textContent = 'Live questions preview';
        return;
      }
      qBtn.disabled = true;
      qBtn.textContent = 'Loading questions…';
      previewPanel.replaceChildren();
      try {
        const [docResult, qnaResult] = await Promise.allSettled([
          podcastDoc ? request(workApiUrl(`/api/sponsor-docs/${encodeURIComponent(podcastDoc.id)}`)) : Promise.resolve(null),
          card.qna?.url ? request(workApiUrl(`/api/cards/${encodeURIComponent(card.id)}/qna/questions`)) : Promise.resolve(null),
        ]);
        const docContent = docResult.status === 'fulfilled' ? (docResult.value?.doc?.content || {}) : {};
        const preparedFields = [
          ['Cold open', docContent.coldOpen],
          ['Intro script', docContent.introScript],
          ['Interview questions', docContent.interviewQuestions],
          ['Topics to cover', docContent.topicsToCover],
          ['Topics to avoid', docContent.topicsToAvoid],
          ['Closing script', docContent.closingScript],
        ].filter(([, val]) => String(val || '').trim());

        const prepHeading = document.createElement('strong');
        prepHeading.textContent = 'Podcast questions & run flow';
        previewPanel.append(prepHeading);
        if (preparedFields.length) {
          for (const [label, val] of preparedFields) {
            const block = document.createElement('div');
            block.className = 'card-live-questions-block';
            const h = document.createElement('div');
            h.className = 'dk-hint';
            h.textContent = label;
            const pre = document.createElement('pre');
            pre.className = 'card-live-questions-text';
            pre.textContent = String(val).trim();
            block.append(h, pre);
            previewPanel.append(block);
          }
        } else {
          const emptyPrep = document.createElement('p');
          emptyPrep.className = 'dk-hint';
          emptyPrep.textContent = 'No prepared questions in the podcast document yet.';
          previewPanel.append(emptyPrep);
        }

        const qnaQuestions = qnaResult.status === 'fulfilled' && Array.isArray(qnaResult.value?.questions)
          ? qnaResult.value.questions
          : (Array.isArray(card.qna?.questions) ? card.qna.questions : []);
        const qnaHeading = document.createElement('strong');
        qnaHeading.textContent = `Audience Q&A questions (${qnaQuestions.length})`;
        previewPanel.append(qnaHeading);
        if (qnaQuestions.length) {
          const list = document.createElement('ol');
          list.className = 'card-qna__questions';
          for (const q of qnaQuestions) {
            const li = document.createElement('li');
            li.textContent = `${q.text} — ${q.authorName || 'Anonymous'}${q.score > 1 ? ` (+${q.score})` : ''}${q.status === 'answered' ? ' ✓ answered' : ''}`;
            list.append(li);
          }
          previewPanel.append(list);
        } else {
          const emptyQna = document.createElement('p');
          emptyQna.className = 'dk-hint';
          emptyQna.textContent = card.qna?.url ? 'No audience questions yet.' : 'No Q&A room linked to this card.';
          previewPanel.append(emptyQna);
        }

        previewPanel.hidden = false;
        qBtn.textContent = 'Hide live questions';
      } catch (err) {
        const errP = document.createElement('p');
        errP.className = 'dk-hint';
        errP.textContent = `Could not load questions: ${err?.message || 'request failed'}`;
        previewPanel.append(errP);
        previewPanel.hidden = false;
        qBtn.textContent = 'Hide live questions';
      } finally {
        qBtn.disabled = false;
      }
    });
  }

  const sponsoredLabel = document.createElement('label');
  sponsoredLabel.className = 'card-sponsored-toggle';
  const sponsoredCheck = document.createElement('input');
  sponsoredCheck.type = 'checkbox';
  sponsoredCheck.checked = card.sponsored === true;
  sponsoredCheck.dataset.cardSponsoredToggle = '';
  sponsoredCheck.addEventListener('change', async () => {
    sponsoredCheck.disabled = true;
    try {
      await request(workApiUrl(`/api/cards/${encodeURIComponent(card.id)}`), {
        method: 'PUT',
        body: JSON.stringify({ expectedVersion: card.version, sponsored: sponsoredCheck.checked }),
      });
      await reload?.();
    } catch {
      sponsoredCheck.checked = card.sponsored === true;
    } finally {
      sponsoredCheck.disabled = false;
    }
  });
  sponsoredLabel.append(sponsoredCheck, document.createTextNode(' Sponsored'));
  row.append(sponsoredLabel);

  bar.append(row);
  if (previewPanel) bar.append(previewPanel);
  return bar;
}

/** Keep the Card panel's document composition in one section owner. */
export function renderCardDocumentSections(context) {
  const shared = renderCardSponsorDocsSection(context.card);
  return [shared, renderCardDocuments(context)].filter(Boolean);
}
