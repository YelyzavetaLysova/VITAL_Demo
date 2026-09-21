/* No UI framework: shared extension panel and responsive paste-text page. */
const $ = (selector) => document.querySelector(selector);
const defaultSettings = {
  theme: "light",
  showTopics: true,
  showAdvertorial: true,
  showSentiment: true,
  showSource: true,
  highlights: true,
  technical: false,
  apiBase: isExtension ? "http://127.0.0.1:8765" : location.origin,
};

let preferences = { ...defaultSettings };
let activeTabId = null;
let currentAnalysis = null;
let pageInfo = {};
let clientId;
let feedbackSent = {};
let busy = false;
let consumingSelection = false;
let activeView = "claims";
let currentPageUrl = "";

function element(tag, className = "", text = "") {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function score(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "Not returned";
  }
  return value >= 0 && value <= 1
    ? `${Math.round(value * 100)}%`
    : String(value);
}

function readable(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value.map(readable).filter(Boolean).join("\n\n");
  if (typeof value === "object") {
    return readable(
      value.text ||
        value.summary ||
        value.explanation ||
        value.passage ||
        value.description,
    );
  }
  return String(value);
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function applyTheme() {
  const dark =
    preferences.theme === "dark" ||
    (preferences.theme === "system" &&
      matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  $("#brandLogo").src = dark
    ? "assets/mf-logo-white.png"
    : "assets/mf-logo.png";
}

function switchTab(name) {
  if (name === "source" && !preferences.showSource) name = "claims";
  if (name === "article" && !hasArticleFeatures()) name = "claims";
  activeView = name;
  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.setAttribute("aria-selected", String(button.dataset.tab === name));
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.hidden = panel.id !== name;
  });
}

function hasArticleFeatures() {
  return (
    preferences.showTopics ||
    preferences.showAdvertorial ||
    preferences.showSentiment
  );
}

function applyVisibility() {
  $("#tab-source").hidden = !preferences.showSource;
  $("#tab-article").hidden = !hasArticleFeatures();
  switchTab(activeView);
}

async function activeTab() {
  if (!isExtension) return null;
  const candidates = [];
  for (const query of [
    { active: true, lastFocusedWindow: true },
    { active: true, currentWindow: true },
    { active: true },
  ]) {
    try {
      candidates.push(...(await extensionApi.tabs.query(query)));
    } catch {}
  }
  const tab = [...new Map(candidates.map((item) => [item.id, item])).values()]
    .filter((item) => item?.id && safeUrl(item.url))
    .sort(
      (left, right) => (right.lastAccessed || 0) - (left.lastAccessed || 0),
    )[0];
  if (!tab?.id || !safeUrl(tab.url)) {
    throw new Error(
      "Open an article webpage before scanning. Browser settings pages cannot be scanned.",
    );
  }
  activeTabId = tab.id;
  currentPageUrl = tab.url;
  return tab;
}

function stateKey(name) {
  return `${name}:${activeTabId || "web"}`;
}

async function fetchJson(base, path, options = {}) {
  let response;
  try {
    response = await fetch(`${base.replace(/\/$/, "")}${path}`, {
      ...options,
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new Error(
      "Cannot reach the backend. Check its address in Settings and that the server is running.",
    );
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      typeof data.detail === "string"
        ? data.detail
        : `Request failed (${response.status}).`,
    );
  }
  return data;
}

function post(body) {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function setBusy(value) {
  busy = value;
  $("#newScan").disabled = value;
  $("#scan").disabled = value;
  $("#pasteForm button").disabled = value;
}

function showError(error) {
  $("#errorText").textContent = error.message || String(error);
  $("#error").hidden = false;
}

function updateProgress(job) {
  $("#progress").hidden = false;
  $("#progressTitle").textContent =
    job.phase === "article"
      ? "Finishing article analysis"
      : "Checking this page";
  const seconds = Math.floor(job.elapsed_seconds || 0);
  $("#elapsed").textContent =
    seconds < 60
      ? `${seconds}s`
      : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  $("#claimProgress").textContent = job.claim_message || job.message;
  $("#articleProgress").textContent =
    hasArticleFeatures() || preferences.showSource ? job.article_message : "";
  if (job.total_claims == null) {
    $("#claimMeter").removeAttribute("value");
  } else {
    $("#claimMeter").max = Math.max(job.total_claims, 1);
    $("#claimMeter").value = job.result
      ? Math.max(job.total_claims, 1)
      : job.completed_claims;
  }
}

async function highlight(claims) {
  if (!isExtension || !activeTabId) return;
  try {
    await extensionApi.tabs.sendMessage(activeTabId, {
      type: "VITAL_HIGHLIGHT",
      claims: preferences.highlights ? claims : [],
    });
  } catch {
    // Reading evidence still works if a page was closed or blocks highlighting.
  }
}

async function pollJob(record) {
  setBusy(true);
  pageInfo = record.pageInfo;
  currentAnalysis = null;
  $("#start").hidden = true;
  $("#pasteForm").hidden = true;
  $("#claimResults").hidden = true;
  $("#claimList").replaceChildren();
  $("#claimCount").textContent = "";
  $("#articleSections").replaceChildren();
  $("#sourceContent").replaceChildren();
  $("#articleEmpty").hidden = false;
  $("#articleEmpty").textContent =
    "Article analysis will appear when processing finishes.";
  $("#sourceEmpty").hidden = false;
  $("#sourceEmpty").textContent =
    "Publisher information will appear when processing finishes.";
  while (true) {
    const job = await fetchJson(
      record.apiBase,
      `/v1/analyse/jobs/${record.job_id}`,
    );
    updateProgress(job);
    if (job.status === "completed" && job.result) {
      render(job.result);
      await sessionStore.set({
        [stateKey("lastAnalysis")]: { data: job.result, pageInfo },
      });
      await highlight(job.result.claims);
    }
    if (job.status === "completed") {
      await sessionStore.remove(stateKey("pendingJob"));
      $("#progress").hidden = true;
      setBusy(false);
      return;
    }
    if (job.status === "failed") {
      await sessionStore.remove(stateKey("pendingJob"));
      throw new Error(
        job.error || "Analysis failed. Check the backend terminal for details.",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
}

async function scan(selectedPayload = null) {
  if (busy) return;
  setBusy(true);
  $("#error").hidden = true;
  $("#progress").hidden = false;
  $("#claimProgress").textContent = "Reading article text.";
  $("#articleProgress").textContent = "";
  $("#elapsed").textContent = "0s";
  $("#claimMeter").removeAttribute("value");
  switchTab("claims");
  try {
    const tab = await activeTab();
    let payload = selectedPayload;
    if (!payload && isExtension) {
      try {
        payload = await extensionApi.tabs.sendMessage(tab.id, {
          type: "VITAL_EXTRACT_PAGE",
        });
      } catch {
        // Tabs that were open while the extension was installed or reloaded do
        // not have its content script yet. Inject it once and retry so a manual
        // page refresh is not required.
        try {
          await extensionApi.scripting.executeScript({
            target: { tabId: tab.id },
            files: ["browser-api.js", "content-script.js"],
          });
          payload = await extensionApi.tabs.sendMessage(tab.id, {
            type: "VITAL_EXTRACT_PAGE",
          });
        } catch {
          throw new Error(
            "VITAL cannot read this page. Allow access to this website, then try again.",
          );
        }
      }
    }
    if (!payload) {
      payload = {
        title: $("#articleTitle").value,
        text: $("#articleText").value,
        language: "en",
      };
      if ($("#articleUrl").value) payload.url = $("#articleUrl").value;
    }
    if (!payload.text || payload.text.trim().length < 12) {
      throw new Error(
        "Not enough article text was found. Wait for the page to load or select a passage.",
      );
    }
    payload.options = {
      topics: preferences.showTopics,
      advertorial: preferences.showAdvertorial,
      sentiment: preferences.showSentiment,
      provider: preferences.showSource,
    };
    const created = await fetchJson(
      preferences.apiBase,
      "/v1/analyse/jobs",
      post(payload),
    );
    const record = {
      job_id: created.job_id,
      apiBase: preferences.apiBase,
      pageInfo: {
        title: payload.title,
        url: payload.url || "",
        tabId: activeTabId,
        apiBase: preferences.apiBase,
      },
    };
    currentAnalysis = null;
    $("#claimResults").hidden = true;
    await sessionStore.set({ [stateKey("pendingJob")]: record });
    await pollJob(record);
  } catch (error) {
    $("#progress").hidden = true;
    setBusy(false);
    showError(error);
  }
}

function metrics(rows) {
  const list = element("dl");
  for (const [label, value] of rows) {
    if (value == null || value === "") continue;
    const row = element("div");
    row.append(element("dt", "", label), element("dd", "", String(value)));
    list.append(row);
  }
  return list;
}

function technicalDetails(raw, rows = []) {
  const details = element("details", "technical");
  details.append(element("summary", "", "Technical details"));
  if (rows.length) details.append(metrics(rows));
  const response = element("details");
  response.append(
    element("summary", "", "API response"),
    element("pre", "", JSON.stringify(raw, null, 2)),
  );
  details.append(response);
  return details;
}

function feedbackBlock(feature, claimId = "") {
  const analysisId = currentAnalysis.analysis_id;
  const key = `${analysisId}:${feature}:${claimId}`;
  if (feedbackSent[key])
    return element("p", "feedback-saved", "Feedback saved");
  const details = element("details", "feedback");
  details.append(element("summary", "", "Give feedback"));
  const form = element("form");
  const label = element("label", "", "Was this useful?");
  const rating = element("select");
  rating.setAttribute("aria-label", "Was this useful?");
  rating.append(
    new Option("Choose a rating", ""),
    new Option("Helpful", "helpful"),
    new Option("Not helpful", "not_helpful"),
  );
  rating.required = true;
  label.append(rating);
  const commentLabel = element("label", "", "Comment · optional");
  const comment = element("textarea");
  comment.rows = 3;
  comment.maxLength = 2000;
  comment.placeholder = "What worked, or what should change?";
  commentLabel.append(comment);
  const submit = element("button", "", "Send");
  submit.type = "submit";
  const message = element("p", "small");
  message.setAttribute("role", "status");
  form.append(
    label,
    commentLabel,
    element(
      "p",
      "small muted",
      "Saved on the backend. Please do not include personal information.",
    ),
    submit,
    message,
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    message.textContent = "Saving…";
    try {
      await fetchJson(
        pageInfo.apiBase || preferences.apiBase,
        "/v1/feedback",
        post({
          analysis_id: analysisId,
          client_id: clientId,
          feature,
          claim_id: claimId,
          rating: rating.value,
          comment: comment.value,
        }),
      );
      feedbackSent[key] = true;
      await localStore.set({ feedbackSent });
      details.replaceWith(element("p", "feedback-saved", "Feedback saved"));
    } catch (error) {
      message.textContent = error.message;
      message.className = "feedback-error";
      submit.disabled = false;
    }
  });
  details.append(form);
  return details;
}

function evidenceItem(item) {
  const node = element("div", "evidence");
  const url = safeUrl(item.url);
  const title = element(
    url ? "a" : "strong",
    "",
    item.title || "Evidence source",
  );
  if (url) {
    title.href = url;
    title.target = "_blank";
    title.rel = "noopener noreferrer";
  }
  node.append(title);
  node.append(
    element(
      "p",
      "source-meta",
      [item.publisher, item.date].filter(Boolean).join(" · "),
    ),
  );
  const stanceLabels = {
    supports: "Supports",
    contradicts: "Contradicts",
    mixed: "Mixed",
    insufficient: "Insufficient",
    qualifies: "Qualifies",
    mentions: "Mentions",
    unknown: "Stance not returned",
  };
  node.append(
    element("span", "source-meta", stanceLabels[item.stance] || item.stance),
  );
  node.append(
    element(
      "p",
      "",
      item.passage ||
        "No evidence passage returned. Open the source to read it.",
    ),
  );
  if (item.reliability)
    node.append(
      element("p", "source-meta", `Provider rating: ${item.reliability}`),
    );
  if (preferences.technical)
    node.append(
      technicalDetails(item.factiverse, [
        ["Stance score", score(item.stance_score)],
        ["Similarity", score(item.similarity_score)],
        ["Citations", item.citation_count],
        ["Bias metadata", item.bias],
        ["Authors", item.authors?.join(", ")],
      ]),
    );
  return node;
}

function claimCard(claim, index) {
  const card = element("details", "claim");
  card.dataset.claimId = claim.id;
  card.dataset.status = claim.status;
  card.style.setProperty("--status-color", `var(--${claim.status})`);
  const summary = element("summary");
  const heading = element("span");
  heading.append(
    element("span", "status", claim.status_label),
    element("span", "claim-text", claim.text),
  );
  const chevron = element("span", "chevron");
  chevron.setAttribute("aria-hidden", "true");
  summary.append(
    element("span", "claim-number", String(index + 1).padStart(2, "0")),
    heading,
    chevron,
  );
  const body = element("div", "claim-body");
  body.append(element("p", "explanation", claim.explanation));
  if (claim.resolved_claim && claim.resolved_claim !== claim.text) {
    body.append(
      element("p", "small muted", `Checked wording: ${claim.resolved_claim}`),
    );
  }
  if (readable(claim.suggested_fix)) {
    const fix = element("details", "note-details");
    fix.append(
      element("summary", "", "Suggested wording"),
      element("p", "", readable(claim.suggested_fix)),
    );
    body.append(fix);
  }
  body.append(element("h3", "", `Evidence (${claim.evidence.length})`));
  if (!claim.evidence.length)
    body.append(
      element(
        "p",
        "small muted",
        "No evidence records returned. See analysis notes for service errors.",
      ),
    );
  claim.evidence.forEach((item) => body.append(evidenceItem(item)));
  if (isExtension) {
    const locate = element("button", "", "Show in article");
    locate.addEventListener("click", async () => {
      try {
        const result = await extensionApi.tabs.sendMessage(activeTabId, {
          type: "VITAL_FOCUS_CLAIM",
          claimId: claim.id,
        });
        if (!result?.found) locate.textContent = "No matching passage";
      } catch {
        locate.textContent = "Article is not available";
      }
    });
    body.append(locate);
  }
  if (preferences.technical)
    body.append(
      technicalDetails(claim.factiverse, [
        ["Detection score", score(claim.detection_score)],
        ["Checkworthiness", claim.checkworthiness],
        ["Verdict confidence", score(claim.final_score)],
      ]),
    );
  body.append(feedbackBlock("claim", claim.id));
  card.append(summary, body);
  return card;
}

function selectClaim(id) {
  switchTab("claims");
  const card = [...document.querySelectorAll(".claim")].find(
    (item) => item.dataset.claimId === id,
  );
  if (!card) return false;
  $("#statusFilter").value = "all";
  filterClaims();
  document
    .querySelectorAll(".claim")
    .forEach((item) => item.classList.toggle("selected", item === card));
  card.open = true;
  card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  return true;
}

async function consumePendingClaim() {
  if (!isExtension) return;
  const { pendingClaim } = await sessionStore.get("pendingClaim");
  if (
    pendingClaim &&
    (!pendingClaim.tabId || pendingClaim.tabId === activeTabId)
  ) {
    if (selectClaim(pendingClaim.claimId || pendingClaim)) {
      await sessionStore.remove("pendingClaim");
    }
  }
}

function filterClaims() {
  const status = $("#statusFilter").value;
  let count = 0;
  document.querySelectorAll(".claim").forEach((card) => {
    card.hidden = status !== "all" && card.dataset.status !== status;
    if (!card.hidden) count++;
  });
  $("#noMatches").hidden = !currentAnalysis?.claims.length || count > 0;
}

function infoSection(title, preview, feature, fill) {
  const details = element("details", "info-section");
  const summary = element("summary");
  const label = element("span");
  label.append(
    element("strong", "", title),
    element("span", "section-preview", preview),
  );
  summary.append(label, element("span", "chevron"));
  const content = element("div", "info-content");
  fill(content);
  content.append(feedbackBlock(feature));
  details.append(summary, content);
  return details;
}

function unavailableText() {
  return "Not available for this analysis";
}

function renderArticle(article) {
  $("#articleSections").replaceChildren();
  $("#articleEmpty").hidden = Boolean(currentAnalysis);
  const target = $("#articleSections");
  if (preferences.showTopics)
    target.append(
      infoSection(
        "Health topics",
        article.topics?.map((item) => item.label).join(", ") ||
          unavailableText(),
        "topics",
        (body) => {
          if (!article.topics?.length)
            body.append(
              element(
                "p",
                "muted",
                "No topics met the model threshold, or the classifier was unavailable.",
              ),
            );
          (article.topics || []).forEach((topic) => {
            const row = element("div", "topic");
            row.append(
              element("span", "", topic.label),
              element("strong", "", score(topic.score)),
            );
            body.append(row);
          });
          body.append(
            element(
              "p",
              "small",
              "Zero-shot classification against predefined health labels. Scores measure label fit, not truth.",
            ),
          );
        },
      ),
    );
  if (preferences.showAdvertorial)
    target.append(
      infoSection(
        "Commercial content",
        article.advertorial?.label || unavailableText(),
        "advertorial",
        (body) => {
          body.append(
            article.advertorial
              ? metrics([
                  ["Classification", article.advertorial.label],
                  ["Model confidence", score(article.advertorial.score)],
                ])
              : element("p", "muted", unavailableText()),
          );
          body.append(
            element(
              "p",
              "small",
              "Model classification only. This does not establish undisclosed advertising.",
            ),
          );
        },
      ),
    );
  if (preferences.showSentiment)
    target.append(
      infoSection(
        "Sentiment",
        article.framing_difference || unavailableText(),
        "sentiment",
        (body) => {
          body.append(
            metrics([
              ["Headline", article.title_sentiment?.label],
              [
                "Headline confidence",
                article.title_sentiment
                  ? score(article.title_sentiment.score)
                  : null,
              ],
              ["Article body", article.content_sentiment?.label],
              [
                "Body confidence",
                article.content_sentiment
                  ? score(article.content_sentiment.score)
                  : null,
              ],
            ]),
          );
          body.append(
            element(
              "p",
              "small",
              "English positive/negative sentiment model; neutral tone may still receive one of these labels. Body analysis uses an excerpt.",
            ),
          );
        },
      ),
    );
  if (article.unavailable?.length) {
    const notes = element("details", "note-details");
    notes.append(element("summary", "", "Classifier notes"));
    article.unavailable.forEach((note) => notes.append(element("p", "", note)));
    target.append(notes);
  }
  $("#sourceEmpty").hidden = true;
  $("#sourceContent").replaceChildren();
  if (preferences.showSource) {
    const provider = article.provider;
    $("#sourceContent").append(
      infoSection(
        "Publisher",
        provider?.name || provider?.domain || unavailableText(),
        "provider",
        (body) => {
          if (provider) {
            body.append(
              metrics([
                ["Name", provider.name],
                ["Domain", provider.domain],
                ["Credibility", provider.credibility],
                ["Bias", provider.bias],
                ["Country", provider.country],
                ["Dataset", provider.source],
              ]),
            );
          } else {
            body.append(
              element(
                "p",
                "muted",
                "No matching publisher metadata. A configured provider dataset is required; no rating is inferred.",
              ),
            );
          }
          body.append(
            element(
              "p",
              "small",
              "Publisher metadata is context, not a verdict on individual claims.",
            ),
          );
        },
      ),
    );
  }
}

function render(data, force = false) {
  const changed = currentAnalysis?.analysis_id !== data.analysis_id;
  currentAnalysis = data;
  $("#start").hidden = true;
  $("#pasteForm").hidden = true;
  $("#claimResults").hidden = false;
  $("#claimCount").textContent = String(data.claims.length);
  $("#resultHeading").textContent =
    `${data.claims.length} claim${data.claims.length === 1 ? "" : "s"}`;
  $("#resultTitle").textContent = pageInfo.title || "";
  $("#scopeNote").textContent =
    `Checks up to ${data.pipeline.max_claims || 5} claims per scan. This is not a complete assessment of the article.`;
  $("#resultDomain").textContent = pageInfo.url
    ? new URL(pageInfo.url).hostname
    : "PASTED TEXT";
  $("#fallbackNotice").hidden = data.mode === "live";
  $("#fallbackNotice").textContent =
    "Factiverse verification was not completed. Local candidates are not verified claims. Check analysis notes.";
  if (changed || force) {
    const opened = new Set(
      [...document.querySelectorAll(".claim[open]")].map(
        (item) => item.dataset.claimId,
      ),
    );
    $("#claimList").replaceChildren(...data.claims.map(claimCard));
    if (!changed)
      document.querySelectorAll(".claim").forEach((card) => {
        card.open = opened.has(card.dataset.claimId);
      });
    $("#detectionFeedback").replaceChildren(feedbackBlock("detection"));
  }
  $("#noClaims").hidden = data.claims.length > 0;
  $("#warningList").replaceChildren(
    ...(data.warnings || []).map((warning) => element("p", "", warning)),
  );
  $("#warnings").hidden = !(data.warnings || []).length;
  renderArticle(data.article || {});
  filterClaims();
  if (isExtension) consumePendingClaim().catch(() => {});
}

async function consumeSelection() {
  if (!isExtension || consumingSelection || busy) return false;
  consumingSelection = true;
  try {
    const { pendingSelection } = await sessionStore.get("pendingSelection");
    if (
      !pendingSelection ||
      (pendingSelection.tabId && pendingSelection.tabId !== activeTabId)
    )
      return false;
    await sessionStore.remove("pendingSelection");
    await scan(pendingSelection);
    return true;
  } finally {
    consumingSelection = false;
  }
}

async function initialise() {
  const saved = await localStore.get({
    preferences: defaultSettings,
    clientId: "",
    feedbackSent: {},
  });
  preferences = { ...defaultSettings, ...saved.preferences };
  if (!["light", "dark"].includes(preferences.theme))
    preferences.theme = "light";
  preferences.showTopics = true;
  preferences.showAdvertorial = true;
  preferences.showSentiment = true;
  preferences.showSource = true;
  preferences.highlights = true;
  preferences.technical = false;
  clientId = saved.clientId || crypto.randomUUID();
  feedbackSent = saved.feedbackSent;
  await localStore.set({ clientId });
  applyTheme();
  applyVisibility();
  $("#theme").value = preferences.theme;
  if (isExtension) {
    try {
      const tab = await activeTab();
      $("#pageTitle").textContent = tab.title || "Find and check claims";
    } catch (error) {
      showError(error);
    }
  } else {
    $("#start").hidden = true;
    $("#pasteForm").hidden = false;
    $("#newScan").textContent = "New article";
  }
  const key = stateKey("lastAnalysis");
  const previous = (await sessionStore.get(key))[key];
  const matchesPage = (record) =>
    !isExtension ||
    record?.pageInfo?.url?.split("#")[0] === currentPageUrl.split("#")[0];
  if (previous && matchesPage(previous)) {
    pageInfo = previous.pageInfo;
    render(previous.data);
  }
  await consumePendingClaim();
  const pendingKey = stateKey("pendingJob");
  const pending = (await sessionStore.get(pendingKey))[pendingKey];
  if (pending && matchesPage(pending)) {
    try {
      await pollJob(pending);
    } catch (error) {
      $("#progress").hidden = true;
      setBusy(false);
      showError(error);
    }
  } else {
    await consumeSelection();
  }
  await consumePendingClaim();
}

document.querySelectorAll("[data-tab]").forEach((button) => {
  button.addEventListener("click", () => switchTab(button.dataset.tab));
  button.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...document.querySelectorAll("[data-tab]")].filter(
      (tab) => !tab.hidden,
    );
    const index = tabs.indexOf(button);
    const next =
      tabs[
        (index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) %
          tabs.length
      ];
    next.focus();
    switchTab(next.dataset.tab);
  });
});
$("#scan").addEventListener("click", () => scan());
$("#retry").addEventListener("click", () => scan());
$("#pasteForm").addEventListener("submit", (event) => {
  event.preventDefault();
  scan();
});
$("#newScan").addEventListener("click", () => {
  if (isExtension) {
    scan();
  } else {
    switchTab("claims");
    $("#pasteForm").hidden = false;
    $("#claimResults").hidden = true;
    $("#articleText").focus();
  }
});
$("#collapseAll").addEventListener("click", () => {
  document.querySelectorAll(".claim").forEach((card) => {
    card.open = false;
  });
});
$("#statusFilter").addEventListener("change", filterClaims);
$("#theme").addEventListener("change", () => {
  preferences.theme = $("#theme").value;
  applyTheme();
});
$("#settingsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  preferences.theme = $("#theme").value;
  await localStore.set({ preferences });
  applyTheme();
  $("#settingsSaved").textContent = "Saved";
});
matchMedia("(prefers-color-scheme: dark)").addEventListener(
  "change",
  applyTheme,
);
if (isExtension) {
  extensionApi.runtime.onMessage.addListener((message) => {
    if (
      message.type === "VITAL_CLAIM_SELECTED" &&
      (!message.tabId || message.tabId === activeTabId)
    )
      selectClaim(message.claimId);
    if (message.type === "VITAL_SELECTION_READY") consumeSelection();
  });
  extensionApi.storage.onChanged.addListener((changes) => {
    if (changes.pendingSelection?.newValue) consumeSelection();
    if (changes.pendingClaim?.newValue) {
      const pending = changes.pendingClaim.newValue;
      if (!pending.tabId || pending.tabId === activeTabId)
        selectClaim(pending.claimId || pending);
    }
  });
}
initialise().catch(showError);
