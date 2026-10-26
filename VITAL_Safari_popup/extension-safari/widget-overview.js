/* Shared presentation rules for the website, Chrome and Safari. */
"use strict";

function claimsInArticleOrder(claims, articleText) {
  const article = normalized(articleText || "").value;
  return claims
    .map((claim, index) => {
      const text = normalized(claim.text || "").value.trim();
      const position = text ? article.indexOf(text) : -1;
      return { claim, index, position: position < 0 ? Infinity : position };
    })
    .sort(
      (a, b) =>
        a.position - b.position ||
        (a.claim.candidate_index ?? a.index) -
          (b.claim.candidate_index ?? b.index) ||
        a.index - b.index,
    )
    .map((item) => item.claim);
}

function toneScore(value) {
  return value?.scale === "minus_one_to_one" &&
    Number.isFinite(value.score) &&
    value.score >= -1 &&
    value.score <= 1
    ? value.score
    : null;
}

function toneDescription(value) {
  const score = toneScore(value);
  if (score !== null) {
    if (score < -0.5) return "Negative";
    if (score < -0.15) return "Slightly negative";
    if (score > 0.5) return "Positive";
    if (score > 0.15) return "Slightly positive";
    return "Neutral";
  }
  const label = String(value?.label || "").trim();
  if (/slightly negative/i.test(label)) return "Slightly negative";
  if (/slightly positive/i.test(label)) return "Slightly positive";
  if (/negative/i.test(label)) return "Negative";
  if (/positive/i.test(label)) return "Positive";
  if (/neutral/i.test(label)) return "Neutral";
  return label || null;
}

function framingBars(data, detailed = false) {
  const group = node("div", "framing-bars");
  for (const [field, title] of [
    ["title_sentiment", "Headline"],
    ["content_sentiment", "Article"],
  ]) {
    const score = toneScore(data[field]);
    if (score === null) continue;
    const item = node("div", "tone-item");
    const caption = node("div", "tone-caption");
    caption.append(
      node("span", "", title),
      node("strong", "", toneDescription(data[field])),
    );
    const track = node("div", "tone-track");
    track.setAttribute("role", "meter");
    track.setAttribute("aria-label", title + " tone");
    track.setAttribute("aria-valuemin", "-1");
    track.setAttribute("aria-valuemax", "1");
    track.setAttribute("aria-valuenow", String(score));
    track.setAttribute(
      "aria-valuetext",
      toneDescription(data[field]) + ", " + score.toFixed(2),
    );
    const marker = node("span", "tone-marker");
    marker.style.left = (score + 1) * 50 + "%";
    marker.title = score.toFixed(2);
    track.append(marker);
    const scale = node("div", "tone-scale");
    for (const tick of ["−1", "0", "+1"]) scale.append(node("span", "", tick));
    item.append(caption, track, scale);
    if (detailed)
      item.append(node("p", "small muted", "Score: " + score.toFixed(2)));
    group.append(item);
  }
  return group;
}

function presentationStatus(status) {
  return ["pending", "skipped"].includes(status) ? "not_health_claim" : status;
}

function detailValue(value) {
  if (value == null) return "Not available";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

function fieldLabel(key) {
  const known = {
    mesh_id: "MeSH ID",
    mesh_tree: "MeSH tree",
    match_types: "Match types",
  };
  if (known[key]) return known[key];
  return key
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function providerRows(provider, record) {
  const names = {
    source_name: "Source",
    name: "Source",
    source_url: "Website",
    domain: "Domain",
    credibility: "Credibility",
    bias: "Bias",
    factual_reporting: "Factual reporting",
    country: "Country",
    media_type: "Media type",
    mbfc_url: "MBFC profile",
    dataset: "Dataset",
    source_id: "Source ID",
  };
  const rows = Object.entries(provider || {}).map(([key, value]) => [
    names[key] || fieldLabel(key),
    detailValue(value),
  ]);
  if (!provider?.source_name && !provider?.name && record.publisher)
    rows.unshift(["Source", record.publisher]);
  if (!provider) rows.push(["Source ratings", "Not available"]);
  if (record.author) rows.push(["Author", record.author]);
  if (record.published_at)
    rows.push(["Published", dateLabel(record.published_at)]);
  return rows;
}

function commercialDescription(value) {
  if (!value?.label) return null;
  const label = String(value.label).toLowerCase().replace(/[_ ]/g, "-");
  if (/non-advertorial|not-advertorial|non-commercial/.test(label))
    return "Not detected";
  if (/^advertorial$|^commercial$|^commercial-content$/.test(label))
    return "Detected";
  return value.label;
}

function claimTotals(analysis) {
  const claims = analysis?.claims || [];
  const statuses = {};
  let analysed = 0;
  const verdicts = new Set([
    "supported",
    "contradicted",
    "mixed",
    "context_needed",
    "insufficient",
  ]);
  for (const claim of claims) {
    const status = presentationStatus(claim.status);
    statuses[status] = (statuses[status] || 0) + 1;
    if (verdicts.has(claim.status)) analysed++;
  }
  const total = Math.max(claims.length, analysis?.detected_count || 0);
  return {
    total,
    analysed,
    statuses,
    awaiting: Math.max(0, total - claims.length),
  };
}

function renderOverview(analysis) {
  const data = analysis?.article || {};
  const provider = data.provider;
  const waiting =
    analysis &&
    !["completed", "failed", "interrupted"].includes(analysis.phase);
  const unavailable = waiting ? "Waiting for result" : "Not available";
  const headline = toneDescription(data.title_sentiment);
  const content = toneDescription(data.content_sentiment);
  const framing = [];
  if (headline) framing.push(["Headline", headline]);
  if (content) framing.push(["Article", content]);
  if (!framing.length) framing.push(["Tone", unavailable]);
  const totals = claimTotals(analysis);
  const countRows = [
    ["Found", totals.total],
    ["Analysed", totals.analysed],
  ];
  for (const [status, count] of Object.entries(totals.statuses))
    countRows.push([labels[status] || status, count, status]);
  if (totals.awaiting)
    countRows.push(["Awaiting claim details", totals.awaiting]);
  const specs = [
    [
      "Source",
      [
        ["Credibility", provider?.credibility ?? unavailable],
        ["Bias", provider?.bias ?? unavailable],
        ["Factual reporting", provider?.factual_reporting ?? unavailable],
      ],
    ],
    [
      "Article framing",
      framing,
      "Tone describes language, not factual accuracy.",
    ],
    [
      "Category and topic",
      [
        ["Category", data.category || unavailable],
        [
          "Topic",
          data.main_topic ||
            data.topics?.map((topic) => topic.label).join(", ") ||
            unavailable,
        ],
        ...(data.descriptive_topic
          ? [["Subtopic", data.descriptive_topic]]
          : []),
      ],
    ],
    [
      "Commercial content",
      [["Result", commercialDescription(data.advertorial) || unavailable]],
      data.advertorial
        ? "Automated classification, not a finding of undisclosed advertising."
        : "",
    ],
    ["Claims", countRows],
  ];
  const container = document.querySelector("#summaryInsights");
  const fingerprint = JSON.stringify([
    specs,
    data.title_sentiment,
    data.content_sentiment,
  ]);
  if (container.dataset.signature === fingerprint) return;
  container.dataset.signature = fingerprint;
  container.replaceChildren(
    ...specs.map(([title, rows, note]) => {
      const card = node("section", "summary-card");
      card.append(node("h3", "", title));
      const list = node("dl");
      for (const [label, value, status] of rows) {
        const row = node("div");
        if (status) row.dataset.status = status;
        row.append(node("dt", "", label), node("dd", "", String(value)));
        list.append(row);
      }
      card.append(list);
      if (title === "Article framing") {
        const bars = framingBars(data);
        if (bars.children.length) {
          list.querySelectorAll("div").forEach((row) => {
            if (
              ["Headline", "Article"].includes(
                row.querySelector("dt").textContent,
              )
            )
              row.remove();
          });
          card.insertBefore(bars, list);
        }
      }
      if (note) card.append(node("p", "small muted", note));
      return card;
    }),
  );
}
