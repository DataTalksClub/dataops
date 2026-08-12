export function createEditorGit(context, services, editorState) {
  const {
    apiUrl, gitCommitButton, gitCommitCancel, gitCommitFiles,
    gitCommitMessage, gitCommitModal, gitCommitSubmit, gitPullButton,
    gitResult, gitSection, gitStatusText, loadDocuments, request,
  } = context;
  const { emptyNote } = services;

  async function refreshGitStatus() {
    try {
      const url = apiUrl("/git/status");
      const payload = await request(url);
      if (!payload.ok) {
        setGitState({
          ok: false,
          message: payload.error || "Git not available",
          count: 0,
        });
        return;
      }
      const count = payload.count || 0;
      const branch = payload.branch || "?";
      editorState.githubBase = payload.github || "";
      editorState.gitBranch = payload.branch || "main";
      updateGithubLink();
      setGitState({
        ok: true,
        count,
        message:
          count === 0
            ? `On ${branch} · nothing to commit`
            : `On ${branch} · ${count} file${count === 1 ? "" : "s"} changed`,
      });
    } catch (err) {
      setGitState({
        ok: false,
        message: err.message || "git endpoint unreachable",
        count: 0,
      });
    }
  }

  function updateGithubLink() {
    // GitHub URLs are used by the Git panel and API, but the main reading UI
    // intentionally avoids extra repository shortcuts.
  }

  function setGitState({ ok, count, message }) {
    gitSection.classList.toggle("git-ok", !!ok && count > 0);
    gitSection.classList.toggle("git-clean", !!ok && count === 0);
    gitSection.classList.toggle("git-unavailable", !ok);
    gitStatusText.textContent = message;
    gitCommitButton.disabled = !ok;
  }

  async function gitPull() {
    gitPullButton.classList.add("is-busy");
    showGitResult("Pulling…", null);
    try {
      const payload = await request(apiUrl("/git/pull"), { method: "POST" });
      if (payload.ok) {
        showGitResult(payload.stdout || "Up to date.", "success");
      } else {
        showGitResult(payload.stderr || "Pull failed", "error");
      }
    } catch (err) {
      showGitResult(`Pull failed: ${err.message}`, "error");
    } finally {
      gitPullButton.classList.remove("is-busy");
      refreshGitStatus();
      await loadDocuments();
    }
  }

  async function openCommitForm() {
    // Refresh first so the file list and default message are up to date.
    let payload;
    try {
      payload = await request(apiUrl("/git/status"));
    } catch (err) {
      showGitResult(`Failed to get status: ${err.message}`, "error");
      return;
    }
    if (!payload || !payload.ok) {
      showGitResult(payload?.error || "Git unavailable", "error");
      return;
    }
    const files = payload.files || [];
    gitResult.hidden = true;
    gitCommitSubmit.disabled = files.length === 0;
    gitCommitFiles.replaceChildren(
      ...(files.length
        ? files.map((f) => {
            const row = document.createElement("div");
            row.className = "git-commit-file";
            const status = document.createElement("span");
            status.className = `git-commit-file-status status-${(f.status || "?").trim().replace(/[^A-Za-z]/g, "") || "u"}`;
            status.textContent = f.status || "?";
            const path = document.createElement("span");
            path.className = "git-commit-file-path";
            path.textContent = f.path;
            row.append(status, path);
            return row;
          })
        : [emptyNote("No changed files.")]),
    );
    gitCommitMessage.value = files.length ? defaultCommitMessage(files) : "";
    gitCommitModal.hidden = false;
    if (files.length) {
      gitCommitMessage.focus();
      gitCommitMessage.select();
    }
  }

  function closeCommitForm() {
    gitCommitModal.hidden = true;
  }

  async function submitCommitForm(event) {
    event.preventDefault();
    const message = gitCommitMessage.value.trim();
    gitCommitSubmit.disabled = true;
    gitCommitSubmit.classList.add("is-busy");
    gitCommitCancel.disabled = true;
    showGitResult("Committing…", null);
    try {
      const payload = await request(apiUrl("/git/commit"), {
        method: "POST",
        body: JSON.stringify({ message: message || undefined, push: true }),
      });
      if (payload.ok && payload.committed) {
        showGitResult(
          payload.pushed
            ? `Committed and pushed · ${payload.message}`
            : `Committed locally · ${payload.message}`,
          "success",
        );
        closeCommitForm();
      } else if (payload.ok) {
        showGitResult(payload.reason || "Nothing to commit.", null);
      } else {
        const failedStep = (payload.steps || []).find((s) => s.exit !== 0);
        const detail = failedStep
          ? `${failedStep.step}: ${failedStep.stderr || failedStep.stdout}`
          : "see server logs";
        showGitResult(`Failed (${detail})`, "error");
      }
    } catch (err) {
      showGitResult(`Failed: ${err.message}`, "error");
    } finally {
      gitCommitSubmit.disabled = false;
      gitCommitSubmit.classList.remove("is-busy");
      gitCommitCancel.disabled = false;
      refreshGitStatus();
    }
  }

  function showGitResult(text, kind) {
    gitResult.classList.remove("git-result-error", "git-result-success");
    if (kind === "error") gitResult.classList.add("git-result-error");
    if (kind === "success") gitResult.classList.add("git-result-success");
    gitResult.textContent = text;
    gitResult.hidden = false;
  }

  function defaultCommitMessage(files) {
    const docFiles = files.filter(
      (f) => f.path.startsWith("content/") && f.path.endsWith(".md"),
    );
    if (docFiles.length === 1) {
      const path = docFiles[0].path;
      return `Update ${path.split("/").pop().replace(/\.md$/, "").replaceAll("-", " ")}`;
    }
    if (docFiles.length > 1) {
      return `Update ${docFiles.length} docs`;
    }
    return `Update ${files.length} file${files.length === 1 ? "" : "s"}`;
  }

  // ---------- View toggle + rendered block view ----------


  return {
    closeCommitForm, gitPull, openCommitForm, refreshGitStatus,
    submitCommitForm, updateGithubLink,
  };
}
