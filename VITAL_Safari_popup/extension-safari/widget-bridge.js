"use strict";
const vitalExtension = true;
// Use device dimensions only on iOS; never size a popup from its own tiny viewport.
if (
  /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
) {
  const width = Math.max(280, Math.min(400, screen.width - 24));
  const height = Math.max(320, Math.min(560, screen.height - 160));
  document.documentElement.style.setProperty("--popup-width", width + "px");
  document.documentElement.style.setProperty("--popup-height", height + "px");
}
const extensionApi = globalThis.browser || globalThis.chrome;
let extensionTab;
let extensionPayload;
let lastHighlight = "";
// Extension storage works independently of the publisher iframe storage policy.
const vitalStorageValues = {};
const vitalStorage = {
  ready: extensionApi.storage.local
    .get(null)
    .then((values) => {
      Object.assign(vitalStorageValues, values);
    })
    .catch(() => {}),
  getItem(key) {
    return vitalStorageValues[key] ?? null;
  },
  setItem(key, value) {
    vitalStorageValues[key] = String(value);
    extensionApi.storage.local
      .set({ [key]: String(value) })
      .catch(console.error);
  },
};
async function startExtension() {
  try {
    const [tab] = await extensionApi.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab?.id || !/^https?:/.test(tab.url || ""))
      throw new Error("Open an article webpage before opening VITAL.");
    const tabId = tab.id;
    extensionTab = tabId;
    let payload;
    try {
      payload = await extensionApi.tabs.sendMessage(tabId, {
        type: "VITAL_EXTRACT_PAGE",
      });
    } catch {
      await extensionApi.scripting.executeScript({
        target: { tabId },
        files: ["mention-navigation.js", "content-script.js"],
      });
      await extensionApi.scripting.insertCSS({
        target: { tabId },
        files: ["content.css"],
      });
      payload = await extensionApi.tabs.sendMessage(tabId, {
        type: "VITAL_EXTRACT_PAGE",
      });
    }
    if (!payload?.text || payload.text.length < 12)
      throw new Error(
        "Not enough article text was found. Wait for the article to load and reopen VITAL.",
      );
    extensionPayload = payload;
    current = {
      id: null,
      title: payload.title || "Current article",
      text: payload.text,
      url: payload.url,
      publisher: payload.publisher || "",
      analysis: null,
    };
    $("#reader").hidden = false;
    $("#catalogue").hidden = true;
    $("#widget").classList.add("open");
    $("#analyseIntro").hidden = false;
    renderAnalysis();
    const pendingKey = "pendingClaim:" + tabId;
    const pending = await extensionApi.storage.local.get(pendingKey);
    if (pending[pendingKey]) {
      selectClaim(pending[pendingKey]);
      await extensionApi.storage.local.remove(pendingKey);
    }
    if (
      ["detecting", "checking", "classifying"].includes(current.analysis?.phase)
    )
      poll();
  } catch (error) {
    $("#reader").hidden = false;
    $("#widget").classList.add("open");
    $("#errorMessage").hidden = false;
    $("#errorMessage").textContent = error.message;
    $("#analyse").disabled = true;
  }
}
async function extensionHighlight(claims) {
  const signature = JSON.stringify(claims);
  if (lastHighlight === signature || !extensionTab) return;
  lastHighlight = signature;
  try {
    await extensionApi.tabs.sendMessage(extensionTab, {
      type: "VITAL_HIGHLIGHT",
      claims,
    });
  } catch {
    /* Keep results visible if the page has navigated. */
  }
}
async function extensionFocus(claimId) {
  await extensionApi.tabs.sendMessage(extensionTab, {
    type: "VITAL_FOCUS_CLAIM",
    claimId,
  });
  extensionClose();
}
function extensionClose() {
  window.close();
}
extensionApi.runtime.onMessage.addListener((message) => {
  if (message.type === "VITAL_CLAIM_SELECTED" && message.tabId === extensionTab)
    selectClaim(message.claimId);
});

document.querySelector("#useSelection").addEventListener("click", async () => {
  try {
    const selection = await extensionApi.tabs.sendMessage(extensionTab, {
      type: "VITAL_GET_SELECTION",
    });
    selectedPassage = selection.selected_text || "";
    $("#claimText").value = selectedPassage;
    $("#manualMessage").textContent = selectedPassage
      ? "Selection imported."
      : "Select a passage in the article first.";
  } catch {
    $("#manualMessage").textContent = "The article is no longer available.";
  }
});

async function extensionFindMention(term, detail = {}) {
  const result = await extensionApi.tabs.sendMessage(extensionTab, {
    type: "VITAL_FIND_MENTION",
    term,
    detail,
  });
  if (result?.found) extensionClose();
  return result;
}

// Opening a panel only extracts text locally. Registration and cache lookup
// happen after an explicit Analyse action and the research-use notice.
async function registerExtensionArticle() {
  if (current?.id) return;
  if (!extensionPayload) throw new Error("Reopen VITAL on the article and try again.");
  current = await api("/api/widget/articles", extensionPayload);
}
