/* Long-running work stays on the backend, not this short-lived worker. */
importScripts("browser-api.js");
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(console.error);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!sender.tab) return false;
  if (!["VITAL_CHECK_SELECTION", "VITAL_CLAIM_SELECTED"].includes(message.type))
    return false;
  // Open immediately while the page click still provides a user gesture.
  const opening = chrome.sidePanel.open({ windowId: sender.tab.windowId });
  const state =
    message.type === "VITAL_CHECK_SELECTION"
      ? { pendingSelection: { ...message.payload, tabId: sender.tab.id } }
      : { pendingClaim: { claimId: message.claimId, tabId: sender.tab.id } };
  Promise.all([opening, sessionStore.set(state)])
    .then(() =>
      chrome.runtime.sendMessage(
        message.type === "VITAL_CHECK_SELECTION"
          ? { type: "VITAL_SELECTION_READY" }
          : {
              type: "VITAL_CLAIM_SELECTED",
              claimId: message.claimId,
              tabId: sender.tab.id,
            },
      ),
    )
    .catch(console.error);
  sendResponse({ accepted: true });
  return false;
});
