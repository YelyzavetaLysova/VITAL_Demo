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

function coverageRows(analysis) {
  // Live counts remain above this section. These figures describe the API's
  // submitted verification set, which can differ from all detected claims.
  if (analysis?.phase !== "completed") return [];
  const coverage = analysis.assessment_coverage;
  if (!coverage || typeof coverage !== "object") return [];
  const rows = [];
  for (const [key, label] of [
    ["submitted_claims", "Sent for checking"],
    ["assessed_claims", "Checked"],
    ["unassessed_claims", "Not checked"],
  ]) {
    const value = coverage[key];
    if (Number.isInteger(value) && value >= 0) rows.push([label, value]);
  }
  const value = coverage.coverage_percent;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100)
    rows.push(["Coverage", value.toLocaleString(undefined, { maximumFractionDigits: 2 }) + "%"]);
  return rows;
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
    countRows.push(["Waiting for claim details", totals.awaiting]);
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
      "Topic and subtopic",
      [
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
        ? "This automatic check looks for promotional content. It cannot confirm whether the publisher was paid."
        : "",
    ],
    ["Claims", countRows],
  ];
  const coverage = coverageRows(analysis);
  if (coverage.length)
    specs.push([
      "Verification coverage",
      coverage,
      "Shows how many submitted claims received a result. A claim can be health-related and still remain unchecked.",
    ]);
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


function historicalContext(data) {
  const box = node("div", "historical-context");
  if (!data || data.status !== "available") {
    const waiting = ["queued", "running", "pending"].includes(data?.status);
    box.append(node("p", "small muted", waiting ? "Historical context is being prepared." : "Historical context is unavailable."));
    return box;
  }
  const number = (v) => typeof v === "number" && Number.isFinite(v);
  const pct = (v) => number(v) ? `${v.toFixed(2)}%` : "Not available";
  const count = (v) => number(v) ? v.toLocaleString("en-GB") : "Not available";
  function rows(parent, values) {
    const dl = node("dl");
    for (const [label, value] of values) {
      const row = node("div");
      row.append(node("dt", "", label), node("dd", "", value));
      dl.append(row);
    }
    parent.append(dl);
  }
  function stats(title, value, overall) {
    const part = node("section");
    part.style.marginBlock = "16px";
    part.append(node("h3", "", title));
    if (!value || value.status !== "available") {
      part.append(node("p", "small muted", "Not available"));
      box.append(part);
      return;
    }
    part.append(node("p", "", `${pct(value.support_percent)} of assessed claims were supported`));
    part.append(node("p", "small muted", title.startsWith("Medical term") ? `Based on assessed claims in articles mentioning ${value.name || "this medical term"}.` : "Based on assessed claims in articles from publishers in this country."));
    rows(part, [
      ["Supported claims across the dataset", pct(value.overall_support_percent ?? overall?.support_percent)],
      ["Articles", count(value.total_articles)],
      ["Assessed claims", count(value.assessed_claims)],
      ["Submitted claims", count(value.submitted_claims)],
      ["Claims assessed (%)", pct(value.assessment_coverage_percent)],
    ]);
    const difference = value.difference_percentage_points;
    if (number(difference)) part.append(node("p", "small", difference === 0
      ? "Same support percentage as the dataset overall."
      : `${Math.abs(difference).toFixed(2)} percentage points ${difference > 0 ? "higher" : "lower"} than the dataset overall.`));
    box.append(part);
    return part;
  }
  stats(`Medical term${data.medical_term?.name ? ": " + data.medical_term.name : ""}`, data.medical_term, data.overall);
  const code = data.country?.country;
  let country = code;
  try { if (code) country = new Intl.DisplayNames(["en"], {type: "region"}).of(code); } catch (_) {}
  const countryPart = stats(`Country${country ? ": " + country : ""}`, data.country, data.overall);
  if (countryPart) countryPart.append(node("p", "small muted", "Country refers to the publisher."));
  const peer = data.country?.peer_comparison;
  if (countryPart && peer?.status === "available") {
    const details = node("details", "note-details");
    details.append(node("summary", "", "Compare with other countries"));
    rows(details, (peer.country_statistics || []).map(v => [v.country, `${pct(v.support_percent)} Supported`]));
    rows(details, [["Comparison average", pct(peer.support_percent)]]);
    details.append(node("p", "small muted", "The comparison averages the country percentages, giving each country equal weight."));
    countryPart.append(details);
  }
  const about = node("details", "note-details");
  about.append(node("summary", "", "About the dataset"));
  const dataset = data.dataset || {};
  const date = v => v ? String(v).slice(0, 10) : "Not available";
  rows(about, [
    ["Dataset", dataset.name || "Not available"], ["Version", dataset.version || "Not available"],
    ["Articles", count(dataset.total_articles)],
    ["Publication dates", `${date(dataset.first_published_at)} to ${date(dataset.last_published_at)}`],
    ["Claims assessed across the dataset (%)", pct(data.overall?.assessment_coverage_percent)],
  ]);
  if (data.medical_term?.mesh_id) rows(about, [["MeSH", data.medical_term.mesh_id]]);
  about.append(node("p", "small muted", "Supported means that the evidence supported the claim. Only assessed claims count towards this percentage. Unchecked claims are not counted as unsupported. The dataset comparison includes this group and does not represent all news."));
  if (data.methodology?.primary_term_method === "most_mentions_mesh_v1")
    about.append(node("p", "small muted", "The medical term is selected by the most mentions and matched using its MeSH identifier."));
  box.append(about);
  return box;
}


function evidenceExplanation(text) {
  const box = node("div", "evidence-explanation");
  const value = String(text);
  const pattern = /\b(SUPPORTS?|REFUTES?|CONTRADICTS?)\s*:\s*/gi;
  const matches = [...value.matchAll(pattern)];
  if (!matches.length) { box.append(node("p", "", value)); return box; }
  const intro = value.slice(0, matches[0].index).trim();
  if (intro) box.append(node("p", "", intro));
  let lastHeading = "", list;
  matches.forEach((match, i) => {
    const heading = /^SUPPORT/i.test(match[1]) ? "Supporting evidence" : "Refuting evidence";
    const passage = value.slice(match.index + match[0].length, matches[i + 1]?.index ?? value.length).trim();
    if (!passage) return;
    if (heading !== lastHeading) {
      box.append(node("h3", "", heading));
      list = node("ul"); list.style.paddingInlineStart = "20px";
      box.append(list); lastHeading = heading;
    }
    const item = node("li", "", passage); item.style.marginBlock = "8px";
    list.append(item);
  });
  return box;
}
