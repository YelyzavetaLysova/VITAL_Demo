"use strict";
const vitalExtension = true;
const extensionApi = globalThis.browser || globalThis.chrome;
let extensionTab;
let lastHighlight = "";
let hostMobile =
  new URLSearchParams(location.hash.slice(1)).get("mobile") === "1";

async function startExtension() {
  try {
    const tabId = Number(
      new URLSearchParams(location.hash.slice(1)).get("tab"),
    );
    if (!tabId) throw new Error("Open VITAL from an article page.");
    extensionTab = tabId;
    const payload = await extensionApi.tabs.sendMessage(tabId, {
      type: "VITAL_EXTRACT_PAGE",
    });
    if (!payload?.text || payload.text.length < 12)
      throw new Error(
        "Not enough article text was found. Wait for the article to load and reopen VITAL.",
      );
    current = await api("/api/widget/articles", payload);
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
  if (hostMobile) extensionClose();
}
function extensionClose() {
  window.parent.postMessage({ type: "VITAL_FRAME_CLOSE" }, "*");
  extensionApi.runtime
    .sendMessage({ type: "VITAL_CLOSE_PANEL", tabId: extensionTab })
    .catch(() => {});
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

window.addEventListener("message", (event) => {
  if (
    event.source === window.parent &&
    event.data?.type === "VITAL_HOST_VIEWPORT"
  )
    hostMobile = Boolean(event.data.mobile);
});

async function extensionFindMention(term, detail = {}) {
  const result = await extensionApi.tabs.sendMessage(extensionTab, {
    type: "VITAL_FIND_MENTION",
    term,
    detail,
  });
  if (result?.found && hostMobile) extensionClose();
  return result;
}
