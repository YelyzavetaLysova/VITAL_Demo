const { JSDOM, VirtualConsole } = require("jsdom");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

(async () => {
  const errors = [];
  let feedbackSaves = 0;
  const record = {
    id: "abc123",
    title: "A selected article",
    text: "The first factual statement appears here.\n\nA second factual statement appears here.",
    publisher: "Test publication",
    author: "Test reporter",
    published_at: "2026-10-01",
    url: "https://example.com/article",
    theme: "other",
    blocks: [
      { type: "paragraph", text: "The first factual statement appears here." },
      {
        type: "image",
        url: "/media/photo.jpg",
        alt: "Photo",
        caption: "Caption",
      },
      { type: "paragraph", text: "A second factual statement appears here." },
    ],
    visible: true,
    image_url: "",
    prepared_at: null,
    analysis: null,
  };
  const prepared = {
    ...record,
    id: "def456",
    title: "Prepared article",
    prepared_at: "2026-10-11T10:00:00Z",
  };
  const claim = {
    id: "claim-1",
    text: "The first factual statement appears here.",
    status: "checking",
    explanation: "Looking for evidence.",
    evidence: [],
  };
  const console = new VirtualConsole();
  console.on("jsdomError", (error) => errors.push(error.message));
  const root = path.join(__dirname, "..");
  const dom = new JSDOM(
    fs.readFileSync(path.join(root, "index.html"), "utf8"),
    {
      url: "http://demo.test/",
      runScripts: "outside-only",
      virtualConsole: console,
      beforeParse(window) {
        window.localStorage.setItem("vital-privacy-acknowledgement", JSON.stringify({version:"2026-10-28.1"}));
        window.matchMedia = () => ({ matches: true });
        window.scrollTo = () => {};
        window.HTMLElement.prototype.scrollIntoView = function () {};
        window.fetch = async (url, options = {}) => {
          let result;
          if (url === "/api/demo/articles")
            result = [record, prepared].map((item) => ({
              ...item,
              excerpt: item.text,
            }));
          else if (url.endsWith("/analyse")) {
            record.analysis = {
              analysis_id: "analysis-1",
              phase: "checking",
              claims: [claim],
              message: "Checking the first five.",
              article: {},
              article_ready: false,
              warnings: [],
            };
            result = { started: true };
          } else if (url.endsWith("/feedback")) {
            feedbackSaves++;
            result = { saved: true };
          } else result = url.endsWith("def456") ? prepared : record;
          return { ok: true, json: async () => structuredClone(result) };
        };
      },
    },
  );
  dom.window.eval(
    fs.readFileSync(path.join(root, "assets/mention-navigation.js"), "utf8"),
  );
  dom.window.eval(
    ["assets/widget-overview.js", "assets/privacy-notice.js", "assets/demo.js"]
      .map((file) => fs.readFileSync(path.join(root, file), "utf8"))
      .join("\n"),
  );
  const document = dom.window.document;
  const $ = (selector) => document.querySelector(selector);
  assert.equal(
    $("#filters"),
    null,
    "Visitors cannot filter stories by category",
  );
  assert.equal(
    $("#claimTheme"),
    null,
    "Visitors cannot choose a claim category",
  );
  async function waitFor(predicate) {
    for (let index = 0; index < 200; index++) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("UI test timed out");
  }
  await waitFor(() => document.querySelectorAll(".story").length === 2);
  $(".story").click();
  await waitFor(() => $("#headline").textContent === record.title);
  assert.equal($("#reader").hidden, false);
  assert.ok($("#byline").textContent.includes("Test reporter"));
  assert.equal(
    $("#widget").classList.contains("open"),
    false,
    $("#errorMessage").textContent,
  );
  assert.equal(
    $(".article-figure img").getAttribute("src"),
    "/media/photo.jpg",
  );
  $("#openWidget").click();
  $("#analyse").click();
  await waitFor(() => $(".claim-card"));
  assert.equal($("mark").dataset.status, "checking");
  assert.equal($("#progress").hidden, false);
  assert.equal($("#claimCount").textContent, "(1)");
  $("mark").click();
  assert.equal($(".claim-card").open, true);
  assert.equal($("#widget").classList.contains("open"), true);
  record.analysis.claims[0] = {
    ...claim,
    status: "supported",
    explanation: "Supported by the returned evidence.",
    evidence: [
      {
        title: "An evidence source",
        url: "https://example.com/source",
        stance: "supports",
        passage: "Source text.",
      },
    ],
  };
  record.analysis.phase = "completed";
  record.analysis.completed_at = "2026-10-12T10:00:00Z";
  record.analysis.article = { topics: [{ label: "other", score: 0.8 }] };
  record.analysis.article_ready = true;
  await waitFor(() => $("mark").dataset.status === "supported");
  assert.equal(
    $(".claim-card").open,
    true,
    "Open evidence card survives gradual updates",
  );
  assert.equal($("#progress").hidden, true);
  assert.equal(
    document.querySelectorAll(".article-figure").length,
    1,
    "Image survives progressive updates",
  );
  assert.equal($(".evidence a").href, "https://example.com/source");
  const feedback = $(".claim-card .feedback form");
  feedback.querySelector(".feedback-choice").click();
  assert.equal(
    feedback.querySelector(".feedback-choice").getAttribute("aria-pressed"),
    "true",
  );
  feedback.dispatchEvent(
    new dom.window.Event("submit", { bubbles: true, cancelable: true }),
  );
  await waitFor(
    () => $(".claim-card .feedback-saved")?.textContent === "Feedback saved",
  );
  assert.equal(feedbackSaves, 1);
  [...document.querySelectorAll(".claim-detail button")]
    .find((item) => item.textContent === "Show in article")
    .click();
  assert.equal(
    $("#widget").classList.contains("open"),
    false,
    "Phone navigation returns to the article",
  );
  $("mark").click();
  assert.equal($("#widget").classList.contains("open"), true);
  $("#theme").value = "dark";
  $("#theme").dispatchEvent(new dom.window.Event("change"));
  assert.equal(document.documentElement.dataset.theme, "dark");
  prepared.analysis = { ...record.analysis, analysis_id: "prepared-1" };
  $(".back-link").click();
  await waitFor(() => !$("#catalogue").hidden);
  await waitFor(() => document.querySelectorAll(".story").length === 2);
  document.querySelectorAll(".story")[1].click();
  await waitFor(() => $("#headline").textContent === "Prepared article");
  assert.equal(
    $("#progress").hidden,
    true,
    "Saved results do not show simulated loading",
  );
  assert.ok($("#cacheNote").textContent.includes("Prepared"));
  assert.equal($("#analyseIntro").hidden, true);
  assert.deepEqual(errors, []);
  process.stdout.write(
    "UI checks passed: catalogue, progressive evidence, persistent card state, mobile navigation, feedback, theme and honest cached results.\n",
  );
  dom.window.close();
})().catch((error) => {
  process.stderr.write(error.stack + "\n");
  process.exit(1);
});
