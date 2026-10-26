"use strict";

const $ = (selector) => document.querySelector(selector);
let stories = [];
let current = null;
let selectedPassage = "";
let pollTimer;
let catalogueTimer;
let routeNumber = 0;
let textSignature = "";
let insightsSignature = "";
const checking = new Set();
const opened = new Set();
function newClientId() {
  if (globalThis.crypto.randomUUID) return crypto.randomUUID();
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
const clientId = localStorage.getItem("vital-demo-client") || newClientId();
localStorage.setItem("vital-demo-client", clientId);
const savedFeedback = JSON.parse(
  localStorage.getItem("vital-demo-feedback") || "{}",
);
const labels = {
  pending: "Not Health Claim",
  skipped: "Not Health Claim",
  not_health_claim: "Not Health Claim",
  checking: "Checking",
  supported: "Supported",
  contradicted: "Contradicted",
  mixed: "Mixed evidence",
  context_needed: "Context needed",
  insufficient: "Insufficient evidence",
  error: "Check failed",
};

function node(tag, className = "", text = "") {
  const item = document.createElement(tag);
  item.className = className;
  item.textContent = text;
  return item;
}

let demoEnded = false;
async function api(path, body) {
  if (demoEnded) throw new Error("This demo has ended.");
  const response = await fetch(
    VITAL_BACKEND_URL.replace(/\/$/, "") + "/demo-api/v1" + path,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = await response.json();
  if (response.status === 410 && data.code === "demo_ended") {
    demoEnded = true;
    clearTimeout(pollTimer);
    clearTimeout(catalogueTimer);
    current = null;
    stories = [];
    for (const child of document.body.children) child.hidden = true;
    document.body.append(node("main", "demo-ended", "This demo has ended."));
    throw new Error("This demo has ended.");
  }
  if (!response.ok)
    throw new Error(
      typeof data.detail === "string"
        ? data.detail
        : "The request could not be completed.",
    );
  return data;
}

function dateLabel(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
}

function timeLabel(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });
}

function safeLink(value) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol) ? value : null;
  } catch {
    return null;
  }
}

function percent(value) {
  return typeof value === "number"
    ? `${Math.round(value * 100)}%`
    : "Not available";
}
function readable(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value.map(readable).filter(Boolean).join("\n\n");
  return readable(
    value.text || value.summary || value.explanation || value.passage,
  );
}

function renderCatalogue() {
  $("#stories").replaceChildren();
  const items = stories;
  $("#stories").classList.toggle("single-story", items.length === 1);
  $("#catalogueMessage").textContent = items.length
    ? ""
    : "No articles here yet. The organizers can add stories before the demo.";
  for (const story of items) {
    const card = node("a", "story");
    card.href = `/article/${story.id}`;
    if (story.image_url) {
      const image = node("img");
      image.src = story.image_url;
      image.alt = "";
      image.loading = "lazy";
      card.append(image);
    }
    card.append(node("p", "eyebrow", story.publisher || "Selected article"));
    card.append(node("h2", "", story.title));
    card.append(
      node(
        "p",
        "meta",
        [story.author, dateLabel(story.published_at)]
          .filter(Boolean)
          .join(" · "),
      ),
    );
    card.append(
      node(
        "p",
        "excerpt",
        `${story.excerpt}${story.excerpt.length >= 220 ? "…" : ""}`,
      ),
    );
    card.append(
      node(
        "p",
        "cache-label",
        ["queued", "running", "detecting", "checking", "classifying"].includes(
          story.analysis_status,
        )
          ? story.analysis_status === "queued"
            ? "Queued for analysis"
            : "Analysis in progress"
          : story.prepared_at
            ? `Prepared ${dateLabel(story.prepared_at)}`
            : "Open to explore the claims",
      ),
    );
    card.addEventListener("click", (event) => {
      if (!event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        navigate(card.href);
      }
    });
    $("#stories").append(card);
  }
}

function showWidget() {
  $("#widget").classList.add("open");
  $("#openWidget").setAttribute("aria-expanded", "true");
  $("#openWidget").hidden = true;
}
function closeWidget() {
  extensionClose();
  return;
  $("#widget").classList.remove("open");
  $("#openWidget").setAttribute("aria-expanded", "false");
  $("#openWidget").hidden = false;
}
function tab(name) {
  document
    .querySelectorAll("[data-view]")
    .forEach((button) =>
      button.setAttribute(
        "aria-selected",
        String(button.dataset.view === name),
      ),
    );
  document.querySelectorAll("[data-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.panel !== name;
  });
}

function normalized(text) {
  let value = "";
  const indices = [];
  for (let index = 0; index < text.length; index++) {
    const character = /\s/.test(text[index]) ? " " : text[index].toLowerCase();
    if (character === " " && value.endsWith(" ")) continue;
    value += character;
    indices.push(index);
  }
  return { value, indices };
}

function highlightClaims(claims) {
  extensionHighlight(claims);
  return;
  const signature = JSON.stringify(
    claims.map((claim) => [claim.id, claim.text]),
  );
  if (signature !== textSignature) {
    textSignature = signature;
    const blocks = current.blocks?.length
      ? current.blocks
      : current.text
          .split(/\n\s*\n/)
          .filter(Boolean)
          .map((text) => ({ type: "paragraph", text }));
    $("#articleBody").replaceChildren(
      ...blocks.map((block) => {
        if (block.type === "image") {
          const figure = node("figure", "article-figure");
          const image = node("img");
          image.src = block.url;
          image.alt = block.alt || "";
          image.loading = "lazy";
          figure.append(image);
          if (block.caption)
            figure.append(node("figcaption", "", block.caption));
          return figure;
        }
        return node(block.type === "heading" ? "h2" : "p", "", block.text);
      }),
    );
    for (const claim of claims) {
      const needle = normalized(claim.text.trim()).value;
      for (const paragraph of $("#articleBody").querySelectorAll("p,h2")) {
        const walker = document.createTreeWalker(
          paragraph,
          NodeFilter.SHOW_TEXT,
        );
        const pieces = [];
        let combined = "";
        let part;
        while ((part = walker.nextNode())) {
          pieces.push({ node: part, offset: combined.length });
          combined += part.nodeValue;
        }
        const haystack = normalized(combined);
        const position = haystack.value.indexOf(needle);
        if (position < 0 || !needle) continue;
        const begin = haystack.indices[position];
        const end = haystack.indices[position + needle.length - 1] + 1;
        const first = pieces.find(
          (piece) =>
            begin >= piece.offset &&
            begin < piece.offset + piece.node.nodeValue.length,
        );
        const last = pieces.find(
          (piece) =>
            end > piece.offset &&
            end <= piece.offset + piece.node.nodeValue.length,
        );
        if (
          !first ||
          !last ||
          first.node.parentElement.closest("mark") ||
          last.node.parentElement.closest("mark")
        )
          continue;
        const mark = node("mark", "claim-mark");
        mark.dataset.claim = claim.id;
        mark.tabIndex = 0;
        mark.setAttribute("role", "button");
        const range = document.createRange();
        range.setStart(first.node, begin - first.offset);
        range.setEnd(last.node, end - last.offset);
        mark.append(range.extractContents());
        range.insertNode(mark);
        mark.addEventListener("click", () => selectClaim(claim.id));
        mark.addEventListener("keydown", (event) => {
          if (["Enter", " "].includes(event.key)) {
            event.preventDefault();
            selectClaim(claim.id);
          }
        });
        break;
      }
    }
  }
  for (const claim of claims) {
    const mark = [...$("#articleBody").querySelectorAll("mark")].find(
      (item) => item.dataset.claim === claim.id,
    );
    if (mark) {
      mark.dataset.status = claim.status;
      mark.title = `${labels[claim.status]}. Open evidence.`;
      mark.setAttribute(
        "aria-label",
        `${claim.text}. ${labels[claim.status]}. Open evidence.`,
      );
    }
  }
}

function focusPassage(id, closeOnMobile = false) {
  extensionFocus(id);
  return true;
  const mark = [...$("#articleBody").querySelectorAll("mark")].find(
    (item) => item.dataset.claim === id,
  );
  if (!mark) return false;
  if (closeOnMobile && matchMedia("(max-width: 760px)").matches) closeWidget();
  mark.scrollIntoView({ behavior: "smooth", block: "center" });
  mark.classList.add("focused");
  setTimeout(() => mark.classList.remove("focused"), 1800);
  return true;
}

function selectClaim(id) {
  tab("claims");
  showWidget();
  const card = [...$("#claimCards").children].find(
    (item) => item.dataset.claim === id,
  );
  if (!card) return;
  opened.add(id);
  card.open = true;
  $("#claimCards")
    .querySelectorAll(".selected")
    .forEach((item) => item.classList.remove("selected"));
  card.classList.add("selected");
  card.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function feedback(feature, claimId = "") {
  const key = `${current.analysis.analysis_id}:${feature}:${claimId}`;
  if (savedFeedback[key]) return node("p", "feedback-saved", "Feedback saved");
  const block = node("details", "feedback note-details");
  block.append(node("summary", "", "Feedback"));
  const form = node("form");
  let rating = "";
  const choices = node("div", "feedback-choices");
  choices.setAttribute("role", "group");
  choices.setAttribute("aria-label", "Is this result correct?");
  const question = node("p", "feedback-question", "Is this result correct?");
  for (const [value, label] of [
    ["correct", "Correct"],
    ["incorrect", "Incorrect"],
    ["unsure", "Not sure"],
  ]) {
    const choice = node("button", "feedback-choice", label);
    choice.type = "button";
    choice.setAttribute("aria-pressed", "false");
    choice.addEventListener("click", () => {
      rating = rating === value ? "" : value;
      for (const button of choices.children)
        button.setAttribute(
          "aria-pressed",
          String(button === choice && Boolean(rating)),
        );
    });
    choices.append(choice);
  }
  const comment = node("textarea");
  comment.rows = 2;
  comment.maxLength = 2000;
  comment.placeholder = "Comment (optional)";
  comment.setAttribute("aria-label", "Optional feedback comment");
  const send = node("button", "", "Send");
  const message = node("p", "small");
  message.setAttribute("role", "status");
  form.className = "feedback-form";
  send.className = "feedback-send";
  send.type = "submit";
  send.textContent = "Send feedback";
  form.append(question, choices, comment, send, message);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!rating && !comment.value.trim()) {
      message.textContent = "Choose an answer or leave a comment.";
      return;
    }
    send.disabled = true;
    try {
      await api(`/api/demo/articles/${current.id}/feedback`, {
        analysis_id: current.analysis.analysis_id,
        client_id: clientId,
        feature,
        claim_id: claimId,
        rating: rating || "comment",
        comment: comment.value,
      });
      savedFeedback[key] = true;
      localStorage.setItem(
        "vital-demo-feedback",
        JSON.stringify(savedFeedback),
      );
      block.replaceWith(node("p", "feedback-saved", "Feedback saved"));
    } catch (error) {
      message.textContent = error.message;
      send.disabled = false;
    }
  });
  block.append(form);
  return block;
}

async function findMention(term, detail = {}) {
  const result = await extensionFindMention(term, detail);

  return result;
}

function upcomingSection(title) {
  const block = node("details", "insight");
  block.append(node("summary", "", title));
  block.append(node("p", "small muted", "Under development."));
  return block;
}

function claimCard(claim, index) {
  const card = node("details", "claim-card");
  card.dataset.claim = claim.id;
  card.dataset.status = presentationStatus(claim.status);
  const summary = node("summary");
  const description = node("span");
  description.append(
    node("span", "claim-label", labels[claim.status] || claim.status_label),
    node("span", "claim-wording", claim.text),
  );
  summary.append(
    node("span", "claim-number", String(index + 1).padStart(2, "0")),
    description,
  );
  card.addEventListener("toggle", () => {
    if (card.open) opened.add(claim.id);
    else opened.delete(claim.id);
  });
  const body = node("div", "claim-detail");
  if (claim.explanation) body.append(node("p", "", claim.explanation));
  if (claim.api_error_type)
    body.append(node("p", "small muted", `API error: ${claim.api_error_type}`));
  if (["pending", "error", "skipped"].includes(claim.status)) {
    const analyse = node(
      "button",
      "primary analyse-claim",
      claim.status === "error" ? "Retry analysis" : "Analyse claim",
    );
    analyse.type = "button";
    analyse.disabled = current.analysis.phase !== "completed";
    analyse.addEventListener("click", () => checkClaim(claim.id));
    body.append(analyse);
    if (analyse.disabled)
      body.append(
        node(
          "p",
          "small muted",
          "Available when the current analysis finishes.",
        ),
      );
  }
  const summaryText = readable(claim.summary);
  if (summaryText && summaryText !== claim.explanation)
    body.append(node("p", "", summaryText));
  if (!["pending", "checking", "error", "skipped"].includes(claim.status)) {
    body.append(node("h3", "", `Evidence · ${(claim.evidence || []).length}`));
    if (!claim.evidence?.length)
      body.append(
        node("p", "small muted", "No evidence sources were returned."),
      );
    for (const evidence of claim.evidence || []) {
      const block = node("div", "evidence");
      const title = node(
        safeLink(evidence.url) ? "a" : "strong",
        "",
        evidence.title || "Evidence source",
      );
      if (safeLink(evidence.url)) {
        title.href = evidence.url;
        title.target = "_blank";
        title.rel = "noopener noreferrer";
      }
      block.append(
        title,
        node(
          "p",
          "source-meta",
          [evidence.publisher, dateLabel(evidence.date), evidence.stance]
            .filter(Boolean)
            .join(" · "),
        ),
        node(
          "p",
          "",
          evidence.passage || "Open the source to read the evidence.",
        ),
      );
      body.append(block);
    }
    if (readable(claim.suggested_fix)) {
      const fix = node("details");
      fix.append(
        node("summary", "", "Suggested wording"),
        node("p", "", readable(claim.suggested_fix)),
      );
      body.append(fix);
    }
  }
  const locate = node("button", "", "Show in article");
  locate.addEventListener("click", () => {
    if (!focusPassage(claim.id, true))
      locate.textContent = "Matching passage not found";
  });
  body.append(locate);
  if (!["pending", "checking", "skipped"].includes(claim.status))
    body.append(feedback("claim", claim.id));
  body.append(upcomingSection("Similar claims"));
  card.append(summary, body);
  return card;
}

function section(title, feature, rows, note = "") {
  const item = node("details", "insight note-details");
  item.append(node("summary", "", title));
  const list = node("dl");
  rows.forEach(([label, value, mention, mentionDetail]) => {
    const row = node("div");
    const heading = node("dt", "", label);
    if (mention) {
      const locate = node("button", "entity-link", label);
      locate.type = "button";
      locate.title = "Find in article. Click again for the next occurrence.";
      locate.setAttribute("aria-label", `Find ${mention} in article`);
      const position = node("span", "entity-position", "Find in article ↗");
      position.setAttribute("role", "status");
      locate.addEventListener("click", async () => {
        const result = await findMention(mention, mentionDetail || {});
        position.textContent = result?.found
          ? `${result.index} of ${result.count} occurrences${result.matchType === "variant" ? " · matched wording: " + result.matchedText : ""}`
          : "Not found in article";
      });
      heading.replaceChildren(locate, position);
    }
    const description = node("dd", "", String(value));
    if (
      ["Website", "MBFC profile"].includes(label) &&
      safeLink(String(value))
    ) {
      const link = node("a", "", String(value));
      link.href = value;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      description.replaceChildren(link);
    }
    row.append(heading, description);
    list.append(row);
  });
  item.append(list);
  if (feature === "content_sentiment")
    item.append(framingBars(current.analysis?.article || {}, true));
  if (note) item.append(node("p", "small muted", note));
  if (current.analysis?.analysis_id) item.append(feedback(feature));
  return item;
}

function renderInsights(analysis) {
  const signature = JSON.stringify([
    analysis.analysis_id,
    analysis.article,
    analysis.article_ready,
    analysis.claims?.map((claim) => [claim.id, claim.text]),
  ]);
  if (signature === insightsSignature) return;
  insightsSignature = signature;
  const data = analysis.article || {};
  const specs = [];
  const topicRows = [
    ["Category", data.category],
    ["Topic", data.main_topic],
    ["Subtopic", data.descriptive_topic],
  ].filter((row) => row[1] != null && row[1] !== "");
  if (topicRows.length)
    specs.push([
      "Category and topics",
      "topics",
      topicRows,
      data.topic_reason || data.classification?.category_reason || "",
    ]);
  if (data.advertorial) {
    const commercialRows = [
      ["Result", commercialDescription(data.advertorial)],
    ];
    specs.push([
      "Commercial content",
      "advertorial",
      commercialRows,
      "Automated classification, not a finding of undisclosed advertising.",
    ]);
  }
  const toneRows = [];
  for (const [field, name] of [
    ["title_sentiment", "Headline"],
    ["content_sentiment", "Article"],
  ]) {
    const value = data[field];
    if (!value) continue;
    if (toneScore(value) === null && toneDescription(value))
      toneRows.push([name, toneDescription(value)]);
    if (value.label && value.scale !== "minus_one_to_one")
      toneRows.push([name + " confidence", percent(value.score)]);
  }
  if (
    toneRows.length ||
    toneScore(data.title_sentiment) !== null ||
    toneScore(data.content_sentiment) !== null
  )
    specs.push([
      "Article framing",
      "content_sentiment",
      toneRows,
      "Tone describes language, not factual accuracy.",
    ]);
  if (data.summary_generated)
    specs.push([
      "Summary",
      "transformation",
      [["Summary", readable(data.summary_generated)]],
    ]);
  const entities = [];
  for (const [field, title] of [
    ["entities_persons", "People"],
    ["entities_organizations", "Organizations"],
    ["entities_locations", "Places"],
    ["entities_misc", "Other entities"],
  ]) {
    for (const [name, detail] of Object.entries(data[field] || {})) {
      const count = typeof detail === "object" ? detail.count : detail;
      entities.push([
        `${title}: ${name}`,
        typeof count === "number" ? `${count} mentions` : "Detected",
        name,
        { ...(typeof detail === "object" ? detail : {}), kind: field },
      ]);
    }
  }
  if (entities.length) specs.push(["Names and places", "entities", entities]);
  const medical = Object.entries(data.entities_medical || {}).map(
    ([name, detail]) => [
      name,
      [
        typeof detail?.count === "number" ? `${detail.count} mentions` : null,
        detail?.mesh_id ? `MeSH: ${detail.mesh_id}` : null,
      ].filter(Boolean).join("\n"),
      name,
      { ...detail, kind: "medical" },
    ],
  );
  if (
    medical.length ||
    data.model_metadata?.task_statuses?.medical_entities === "completed"
  )
    specs.push([
      "Medical terms",
      "medical_entities",
      medical.length ? medical : [["Result", "None detected"]],
      "MeSH identifies terms in the Medical Subject Headings vocabulary. These are terminology references, not diagnoses.",
    ]);
  if (typeof data.word_count === "number")
    specs.push(["Word count", "word_count", [["Words", data.word_count]]]);
  function reconcile(container, sections) {
    [...container.children]
      .filter((item) => !item.matches("details.insight"))
      .forEach((item) => item.remove());
    const old = new Map(
      [...container.querySelectorAll("details.insight")].map((item) => [
        item.dataset.feature,
        item,
      ]),
    );
    for (const spec of sections) {
      const previous = old.get(spec[1]);
      const fingerprint = JSON.stringify([
        spec,
        spec[1] === "content_sentiment"
          ? [data.title_sentiment, data.content_sentiment]
          : null,
      ]);
      if (previous?.dataset.signature === fingerprint) {
        old.delete(spec[1]);
        container.append(previous);
        continue;
      }
      const item = section(...spec);
      item.dataset.feature = spec[1];
      item.dataset.signature = fingerprint;
      if (previous) {
        item.open = previous.open;
        previous.replaceWith(item);
        old.delete(spec[1]);
      }
      container.append(item);
    }
    old.forEach((item) => item.remove());
  }
  reconcile($("#articleInsights"), specs);
  if (data.claim_classification?.length) {
    const group = node("details", "insight note-details");
    group.dataset.feature = "claim-classification-group";
    group.append(node("summary", "", "Claim classification"));
    for (const item of data.claim_classification) {
      const claim =
        analysis.claims?.find((claim) => claim.id === item.claim_id) ||
        analysis.claims?.find(
          (claim) => claim.candidate_index === item.candidate_index,
        ) ||
        (item.claim_id ? { id: item.claim_id, text: item.text } : null);
      const card = node("details", "classification-card note-details");
      card.append(
        node("summary", "", claim?.text || `Claim ${item.candidate_index + 1}`),
      );
      card.append(node("p", "", item.category || "Unclassified"));
      if (item.reason) card.append(node("p", "small", item.reason));
      if (claim) card.append(feedback("claim_classification", claim.id));
      group.append(card);
    }
    $("#articleInsights").append(group);
  }

  for (const message of data.unavailable || [])
    $("#articleInsights").append(node("p", "small muted", message));
  if (!$("#articleInsights").children.length)
    $("#articleInsights").append(
      node(
        "p",
        "muted",
        analysis.article_ready
          ? "No classifier results are available."
          : "Classifiers are still processing.",
      ),
    );
  const sourceRows = providerRows(data.provider, current);
  reconcile(
    $("#sourceInsights"),
    sourceRows.length ? [["Source information", "provider", sourceRows]] : [],
  );
  if (current.url && safeLink(current.url)) {
    const original = node("a", "source-original", "Open original article ↗");
    original.href = current.url;
    original.target = "_blank";
    original.rel = "noopener noreferrer";
    $("#sourceInsights").append(original);
  }
}

let overviewAnalysisKey = "";
function renderAnalysis() {
  const analysis = current.analysis;
  const overviewKey = `${current.id}:${analysis?.analysis_id || "new"}`;
  if (overviewAnalysisKey !== overviewKey) {
    overviewAnalysisKey = overviewKey;
    tab("summary");
  }
  renderOverview(analysis);
  const isRunning =
    analysis &&
    ["detecting", "checking", "classifying"].includes(analysis.phase);
  $("#analyseIntro").hidden = Boolean(
    analysis &&
    !analysis.prepared_features &&
    !["failed", "interrupted"].includes(analysis.phase),
  );
  $("#analyse").disabled = Boolean(isRunning);
  $("#analyse").textContent =
    analysis?.phase === "interrupted" ? "Resume analysis" : "Analyse";
  $("#progress").hidden = !isRunning && checking.size === 0;
  $("#progressText").textContent =
    analysis?.remote_status === "queued"
      ? "Queued for analysis. You can leave this page and return later."
      : analysis?.message || "Checking claim.";
  $("#cacheNote").hidden = !analysis?.completed_at && !current.prepared_at;
  $("#cacheNote").textContent = current.prepared_at
    ? `Prepared ${timeLabel(current.prepared_at)}`
    : analysis?.completed_at
      ? `Analysed ${timeLabel(analysis.completed_at)}`
      : "";
  $("#errorMessage").hidden = !["failed", "interrupted"].includes(
    analysis?.phase,
  );
  if (["failed", "interrupted"].includes(analysis?.phase))
    $("#errorMessage").textContent = analysis.message;
  if (!analysis) {
    $("#claimCount").textContent = "(0)";
    highlightClaims([]);
    renderInsights({ article: {}, claims: [], article_ready: false });
    return;
  }
  const claims = claimsInArticleOrder(analysis.claims || [], current.text);
  $("#claimCount").textContent =
    `(${Math.max(claims.length, analysis.detected_count || 0)})`;
  $("#openWidget").textContent = claims.length
    ? `VITAL · ${claims.length} claims`
    : "VITAL · Open evidence";
  $("#claimScope").hidden = true;
  $("#noClaims").hidden = claims.length > 0 || analysis.phase !== "completed";
  const existing = new Map(
    [...$("#claimCards").children].map((card) => [card.dataset.claim, card]),
  );
  claims.forEach((claim, index) => {
    const old = existing.get(claim.id);
    const signature = JSON.stringify([
      claim,
      index,
      analysis.phase === "completed",
    ]);
    if (old?.dataset.signature === signature) {
      existing.delete(claim.id);
      $("#claimCards").append(old);
      return;
    }
    const card = claimCard(claim, index);
    card.dataset.signature = signature;
    card.open = old ? old.open : opened.has(claim.id);
    if (old) {
      card.classList.toggle("selected", old.classList.contains("selected"));
      old.replaceWith(card);
      existing.delete(claim.id);
    }
    $("#claimCards").append(card);
  });
  existing.forEach((card) => card.remove());
  highlightClaims(claims);
  renderInsights(analysis);
  if (claims.length && !$("#detectionFeedback").children.length)
    $("#detectionFeedback").append(feedback("detection"));
  $("#analysisNotes").hidden = !analysis.warnings?.length;
  $("#notesText").replaceChildren(
    ...(analysis.warnings || []).map((text) => node("p", "small", text)),
  );
}

async function refreshArticle(expectedRoute) {
  if (!current) return;
  const identifier = current.id;
  const record = await api(`/api/demo/articles/${identifier}`);
  if (expectedRoute !== routeNumber || current?.id !== identifier) return;
  current = record;
  renderAnalysis();
}

function poll() {
  clearTimeout(pollTimer);
  const expectedRoute = routeNumber;
  pollTimer = setTimeout(async () => {
    try {
      await refreshArticle(expectedRoute);
      if (expectedRoute !== routeNumber) return;
      if (
        checking.size ||
        ["detecting", "checking", "classifying"].includes(
          current?.analysis?.phase,
        )
      )
        poll();
    } catch (error) {
      $("#errorMessage").hidden = false;
      $("#errorMessage").textContent = error.message;
    }
  }, 1000);
}

async function checkClaim(id) {
  if (checking.has(id) || current.analysis.phase !== "completed") return;
  const claim = current.analysis.claims.find((item) => item.id === id);
  if (!claim || !["pending", "error", "skipped"].includes(claim.status)) return;
  checking.add(id);
  claim.status = "checking";
  claim.explanation = "Looking for evidence.";
  renderAnalysis();
  poll();
  const expectedRoute = routeNumber;
  const identifier = current.id;
  try {
    await api(`/api/demo/articles/${identifier}/claims/${id}/check`, {});
    await refreshArticle(expectedRoute);
  } catch (error) {
    $("#errorMessage").hidden = false;
    $("#errorMessage").textContent = error.message;
  } finally {
    checking.delete(id);
    if (expectedRoute === routeNumber) {
      renderAnalysis();
      if (checking.size) poll();
    }
  }
}

async function route() {
  const version = ++routeNumber;
  clearTimeout(pollTimer);
  checking.clear();
  opened.clear();
  closeWidget();
  clearTimeout(catalogueTimer);
  textSignature = "";
  insightsSignature = "";
  selectedPassage = "";
  current = null;
  const match = location.pathname.match(/^\/article\/([a-f0-9]+)$/);
  $("#catalogue").hidden = Boolean(match);
  $("#reader").hidden = !match;
  try {
    if (!match) {
      stories = await api("/api/demo/articles");
      if (version === routeNumber) {
        renderCatalogue();
        catalogueTimer = setTimeout(refreshCatalogue, 5000);
      }
      return;
    }
    const record = await api(`/api/demo/articles/${match[1]}`);
    if (version !== routeNumber) return;
    current = record;
    document.title = `${record.title} · VITAL`;
    $("#publisher").textContent = record.publisher;
    $("#headline").textContent = record.title;
    $("#byline").textContent = [record.author, dateLabel(record.published_at)]
      .filter(Boolean)
      .join(" · ");
    $("#sourceLink").hidden = !safeLink(record.url);
    if (safeLink(record.url)) $("#sourceLink").href = record.url;
    $("#hero").hidden = !record.image_url;
    if (record.image_url) $("#heroImage").src = record.image_url;
    highlightClaims([]);
    $("#claimCards").replaceChildren();
    $("#detectionFeedback").replaceChildren();
    $("#claimCount").textContent = "";
    $("#cacheNote").hidden = true;
    $("#claimScope").hidden = true;
    $("#errorMessage").hidden = true;
    $("#claimText").value = "";
    $("#manualMessage").textContent = "";
    $("#articleInsights").replaceChildren(
      node("p", "muted", "Available after analysis."),
    );
    $("#sourceInsights").replaceChildren(
      node("p", "muted", "Available after analysis."),
    );
    tab("summary");
    renderAnalysis();
    if (
      ["detecting", "checking", "classifying"].includes(record.analysis?.phase)
    )
      poll();
  } catch (error) {
    if (match) {
      $("#errorMessage").hidden = false;
      $("#errorMessage").textContent = error.message;
      showWidget();
    } else $("#catalogueMessage").textContent = error.message;
  }
}

async function refreshCatalogue() {
  if (location.pathname !== "/") return;
  try {
    stories = await api("/api/demo/articles");
    renderCatalogue();
  } catch {
    /* Keep existing cards if the network is temporarily unavailable. */
  }
  catalogueTimer = setTimeout(refreshCatalogue, 5000);
}

$("#addArticleForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#addArticleForm button");
  button.disabled = true;
  $("#addArticleMessage").textContent = "Importing article.";
  try {
    const result = await api("/api/demo/import", {
      url: $("#addArticleUrl").value,
    });
    $("#addArticleMessage").textContent =
      result.warnings?.join(" ") || "Added. Analysis started.";
    $("#addArticleUrl").value = "";
    stories = await api("/api/demo/articles");
    renderCatalogue();
  } catch (error) {
    $("#addArticleMessage").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

function navigate(url) {
  history.pushState({}, "", url);
  window.scrollTo(0, 0);
  route();
}
window.addEventListener("popstate", route);
document.querySelectorAll('a[href="/"]').forEach((link) =>
  link.addEventListener("click", (event) => {
    event.preventDefault();
    navigate("/");
  }),
);
document
  .querySelectorAll("[data-view]")
  .forEach((button) =>
    button.addEventListener("click", () => tab(button.dataset.view)),
  );
$("#openWidget").addEventListener("click", showWidget);
$("#closeWidget").addEventListener("click", closeWidget);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeWidget();
});
$("#analyse").addEventListener("click", async () => {
  $("#analyse").disabled = true;
  $("#errorMessage").hidden = true;
  const expectedRoute = routeNumber;
  try {
    await api(`/api/demo/articles/${current.id}/analyse`, {});
    await refreshArticle(expectedRoute);
    poll();
  } catch (error) {
    $("#errorMessage").hidden = false;
    $("#errorMessage").textContent = error.message;
    $("#analyse").disabled = false;
  }
});
document.addEventListener("selectionchange", () => {
  const selection = getSelection();
  if (
    selection &&
    $("#articleBody").contains(selection.anchorNode) &&
    $("#articleBody").contains(selection.focusNode) &&
    selection.toString().trim().length >= 12
  )
    selectedPassage = selection.toString().trim();
});
$("#useSelection").addEventListener("click", () => {
  $("#claimText").value = selectedPassage;
  $("#manualMessage").textContent = selectedPassage
    ? "Selection imported."
    : "Select a passage in the article first.";
});
$("#manualForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = await api(`/api/demo/articles/${current.id}/claims`, {
      text: $("#claimText").value,
    });
    await refreshArticle(routeNumber);
    selectClaim(result.claim_id);

    $("#manualMessage").textContent = "Claim added.";
  } catch (error) {
    $("#manualMessage").textContent = error.message;
  }
});
$("#theme").value =
  localStorage.getItem("vital-demo-theme") === "dark" ? "dark" : "light";
document.documentElement.dataset.theme = $("#theme").value;
$("#theme").addEventListener("change", () => {
  document.documentElement.dataset.theme = $("#theme").value;
  localStorage.setItem("vital-demo-theme", $("#theme").value);
});
startExtension();
