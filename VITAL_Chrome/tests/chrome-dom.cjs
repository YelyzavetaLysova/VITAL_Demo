const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM, VirtualConsole } = require("jsdom");

async function checkBuild(folder) {
  const root = path.join(__dirname, "..", folder);
  const errors = [];
  const listeners = [];
  const calls = [];
  const article = {
    id: "abc123",
    title: "Article",
    url: "https://example.com/story",
    text: "A factual claim appears in this article.",
    publisher: "Publisher",
    theme: "other",
    analysis: null,
  };
  const console = new VirtualConsole();
  console.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM(
    fs.readFileSync(path.join(root, "sidepanel.html"), "utf8"),
    {
      url: "http://widget.test/sidepanel.html#tab=12",
      runScripts: "outside-only",
      virtualConsole: console,
      beforeParse(window) {
        window.matchMedia = () => ({ matches: true });
        window.HTMLElement.prototype.scrollIntoView = () => {};
        window.chrome = {
          runtime: {
            id: "widget",
            onMessage: { addListener: (fn) => listeners.push(fn) },
            sendMessage: async (message) => calls.push(message),
          },
          tabs: {
            sendMessage: async (id, message) => {
              calls.push({ id, ...message });
              return message.type === "VITAL_EXTRACT_PAGE"
                ? article
                : { selected_text: "A factual claim appears in this article." };
            },
          },
          storage: { local: { get: async () => ({}), remove: async () => {} } },
        };
        window.fetch = async (url, options = {}) => {
          assert.ok(url.startsWith("https://vital.demo.mediafutures.no/"));
          if (url.endsWith("/analyse"))
            article.analysis = {
              analysis_id: "test-analysis",
              phase: "completed",
              claims: [
                {
                  id: "claim-1",
                  text: article.text,
                  status: "supported",
                  explanation: "Returned result",
                  evidence: [],
                },
              ],
              article: {
                category: "health",
                title_sentiment: { score: 0, scale: "minus_one_to_one" },
                content_sentiment: { score: -0.42, scale: "minus_one_to_one" },
                word_count: 7,
                main_topic: "Exercise",
                descriptive_topic: "Walking",
                entities_persons: {
                  "Test Reporter": { count: 1, confidence: 0.9 },
                },
              },
              article_ready: true,
              warnings: [],
            };
          return { ok: true, json: async () => structuredClone(article) };
        };
      },
    },
  );
  const window = dom.window;
  window.eval(
    ["config.js", "widget-bridge.js", "widget-overview.js", "sidepanel.js"]
      .map((file) => fs.readFileSync(path.join(root, file), "utf8"))
      .join("\n"),
  );
  const waitFor = async (predicate) => {
    for (let i = 0; i < 100; i++) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Widget test timed out");
  };
  const $ = (selector) => window.document.querySelector(selector);
  await waitFor(() => $("#reader").hidden === false);
  assert.equal($("#widget").classList.contains("open"), true);
  assert.equal(window.document.querySelectorAll("#analyse").length, 1);
  $("#analyse").click();
  await waitFor(() => $(".claim-card"));
  assert.equal($("#claimCount").textContent, "(1)");
  assert.ok(calls.some((message) => message.type === "VITAL_HIGHLIGHT"));
  listeners.forEach((fn) =>
    fn({ type: "VITAL_CLAIM_SELECTED", tabId: 12, claimId: "claim-1" }),
  );
  assert.equal($(".claim-card").open, true);
  assert.ok($(".claim-card .feedback .feedback-choice"));
  assert.equal($("#closeWidget").getAttribute("aria-label"), "Close VITAL");
  assert.equal($("#closeWidget").getAttribute("type"), "button");
  assert.ok($("#closeWidget svg"));
  assert.ok(
    $("#articleInsights").textContent.includes("Neutral"),
    "Neutral numeric sentiment is shown",
  );
  assert.ok($("#articleInsights").textContent.includes("Slightly negative"));
  assert.ok(!$("#articleInsights").textContent.includes("undefined"));
  const beforeClose = calls.filter(
    (message) => message.type === "VITAL_CLOSE_PANEL",
  ).length;
  [...window.document.querySelectorAll(".claim-detail button")]
    .find((button) => button.textContent === "Show in article")
    .click();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(
    calls.filter((message) => message.type === "VITAL_CLOSE_PANEL").length,
    beforeClose,
    "Narrow desktop iframe does not imply phone",
  );
  $("#closeWidget").click();
  await waitFor(() =>
    calls.some((message) => message.type === "VITAL_CLOSE_PANEL"),
  );
  assert.deepEqual(errors, []);
  dom.window.close();
}

function checkContentScript() {
  const callbacks = [];
  const messages = [];
  const dom = new JSDOM(
    "<article><h1>Headline</h1><p>A factual claim appears in this article.</p></article>",
    { url: "https://example.com/story", runScripts: "outside-only" },
  );
  const api = {
    runtime: {
      getURL: (file) => "chrome-extension://widget/" + file,
      onMessage: { addListener: (fn) => callbacks.push(fn) },
      sendMessage: async (message) => messages.push(message),
    },
  };
  dom.window.chrome = api;
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const script = fs.readFileSync(
    path.join(__dirname, "../extension/content-script.js"),
    "utf8",
  );
  dom.window.eval(script);
  dom.window.eval(script);
  assert.equal(
    callbacks.length,
    1,
    "Reinjection never registers duplicate listeners",
  );
  let extracted;
  callbacks[0](
    { type: "VITAL_EXTRACT_PAGE" },
    {},
    (result) => (extracted = result),
  );
  assert.ok(extracted.text.includes("A factual claim"));
  callbacks[0]({ type: "VITAL_OPEN_PANEL", tabId: 12 }, {}, () => {});
  const host = dom.window.document.querySelector("#vital-demo-panel");
  assert.ok(host.shadowRoot.querySelector("iframe"));
  callbacks[0]({ type: "VITAL_CLOSE_PANEL" }, {}, () => {});
  assert.equal(host.hidden, true);
  callbacks[0]({ type: "VITAL_OPEN_PANEL", tabId: 12 }, {}, () => {});
  assert.equal(host.hidden, false);
  callbacks[0](
    { type: "VITAL_OPEN_PANEL", tabId: 12, toggle: true },
    {},
    () => {},
  );
  assert.equal(
    host.hidden,
    true,
    "Toolbar action toggles an open panel closed",
  );
  callbacks[0]({ type: "VITAL_OPEN_PANEL", tabId: 12 }, {}, () => {});
  dom.window.document.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", { key: "Escape" }),
  );
  assert.equal(host.hidden, true, "Escape closes the host panel");
  callbacks[0](
    {
      type: "VITAL_HIGHLIGHT",
      claims: [
        {
          id: "claim-1",
          text: "A factual claim appears in this article.",
          status: "supported",
          status_label: "Supported",
        },
      ],
    },
    {},
    () => {},
  );
  const mark = dom.window.document.querySelector("mark");
  assert.ok(mark);
  mark.click();
  assert.equal(messages[0].type, "VITAL_CLAIM_SELECTED");
  dom.window.close();
}

(async () => {
  for (const folder of ["extension"])
    await checkBuild(folder);
  checkContentScript();
  process.stdout.write(
    "Chrome source DOM checks passed: API bridge, highlights, drawer, count, feedback and reinjection.\n",
  );
})().catch((error) => {
  process.stderr.write(error.stack + "\n");
  process.exit(1);
});
