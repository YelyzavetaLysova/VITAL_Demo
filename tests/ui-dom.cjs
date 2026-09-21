const { JSDOM, VirtualConsole } = require("jsdom");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

(async () => {
  let statusReads = 0;
  let feedbackCount = 0;
  let requestedOptions;
  const errors = [];
  const testData = {
    analysis_id: "ui-analysis",
    mode: "live",
    warnings: [],
    pipeline: { max_claims: 5 },
    claims: [
      {
        id: "claim-1",
        text: "First claim about coffee.",
        status: "supported",
        status_label: "Supported",
        explanation: "Test fixture.",
        evidence: [],
        factiverse: {},
      },
      {
        id: "claim-2",
        text: "Second claim about sleep.",
        status: "insufficient",
        status_label: "Insufficient evidence",
        explanation: "Test fixture.",
        evidence: [],
        factiverse: {},
      },
    ],
    article: { topics: [{ label: "sleep", score: 0.8 }], unavailable: [] },
  };
  const console = new VirtualConsole();
  console.on("jsdomError", (error) => errors.push(error.message));
  const uiRoot = path.join(__dirname, "../extension");
  const dom = new JSDOM(
    fs.readFileSync(path.join(uiRoot, "sidepanel.html"), "utf8"),
    {
      url: "http://localhost/app/sidepanel.html",
      runScripts: "outside-only",
      virtualConsole: console,
      beforeParse(window) {
        window.matchMedia = () => ({ matches: false, addEventListener() {} });
        window.crypto.randomUUID = randomUUID;
        window.AbortSignal.timeout = globalThis.AbortSignal.timeout;
        window.HTMLElement.prototype.scrollIntoView = function () {};
        window.fetch = async (url, options = {}) => {
          let data;
          if (url.endsWith("/v1/feedback")) {
            feedbackCount++;
            data = { saved: true, feedback_id: 1 };
          } else if (options.method === "POST") {
            requestedOptions = JSON.parse(options.body).options;
            data = { job_id: "ui-job" };
          } else {
            statusReads++;
            data = {
              status: statusReads === 1 ? "running" : "completed",
              elapsed_seconds: 2,
              completed_claims: 2,
              total_claims: 2,
              claim_message: "Checks completed.",
              article_message: "Classifying topics.",
              result:
                statusReads === 1 ? { ...testData, article: {} } : testData,
            };
          }
          return { ok: true, json: async () => data };
        };
      },
    },
  );
  dom.window.eval(
    ["browser-api.js", "sidepanel.js"]
      .map((name) => fs.readFileSync(path.join(uiRoot, name), "utf8"))
      .join("\n"),
  );
  const document = dom.window.document;
  const $ = (selector) => document.querySelector(selector);
  async function waitFor(predicate) {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("DOM check timed out");
  }
  await waitFor(() => !$("#pasteForm").hidden);
  $("#articleTitle").value = "Test article";
  $("#articleText").value =
    "First claim about coffee and a second claim about sleep.";
  $("#pasteForm").dispatchEvent(
    new dom.window.Event("submit", { bubbles: true, cancelable: true }),
  );
  await waitFor(() => statusReads === 1);
  assert.equal(
    document.querySelectorAll(".claim").length,
    0,
    "Do not show partial results",
  );
  assert.equal($("#progress").hidden, false);
  await waitFor(() => $("#progress").hidden);
  assert.equal(document.querySelectorAll(".claim").length, 2);
  assert.equal(document.querySelectorAll(".claim[open]").length, 0);
  $(".claim > summary").click();
  assert.equal($(".claim").open, true);
  $(".claim > summary").click();
  assert.equal($(".claim").open, false, "Second click closes claim");
  assert.equal(
    requestedOptions.topics &&
      requestedOptions.advertorial &&
      requestedOptions.sentiment &&
      requestedOptions.provider,
    true,
  );
  $(".claim > summary").click();
  const form = $(".claim .feedback form");
  form.querySelector("select").value = "helpful";
  form.dispatchEvent(
    new dom.window.Event("submit", { bubbles: true, cancelable: true }),
  );
  await waitFor(() => $(".claim .feedback-saved"));
  assert.equal(feedbackCount, 1);
  assert.equal($(".claim").getElementsByClassName("feedback").length, 0);
  $("#statusFilter").value = "insufficient";
  $("#statusFilter").dispatchEvent(new dom.window.Event("change"));
  assert.equal(
    [...document.querySelectorAll(".claim")].filter((card) => !card.hidden)
      .length,
    1,
  );
  $("#tab-settings").click();
  $("#theme").value = "dark";
  $("#theme").dispatchEvent(new dom.window.Event("change"));
  $("#settingsForm").dispatchEvent(
    new dom.window.Event("submit", { bubbles: true, cancelable: true }),
  );
  await waitFor(() => $("#settingsSaved").textContent === "Saved");
  assert.equal(document.documentElement.dataset.theme, "dark");
  assert.equal($("#tab-source").hidden, false);
  const saved = JSON.parse(
    dom.window.localStorage.getItem("vital:preferences"),
  );
  assert.equal(saved.theme, "dark");
  assert.equal(
    JSON.parse(dom.window.localStorage.getItem("vital:feedbackSent"))[
      "ui-analysis:claim:claim-1"
    ],
    true,
  );
  assert.deepEqual(errors, []);
  process.stdout.write(
    "DOM checks passed: initialisation, atomic results, collapse, filtering, theme/settings, feedback opt-in/persistence.\n",
  );
  dom.window.close();
})().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});
