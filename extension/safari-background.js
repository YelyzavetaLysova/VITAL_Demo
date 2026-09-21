/* Safari uses an on-page panel instead of Chrome's sidePanel API. */
const api = globalThis.browser || globalThis.chrome;
const state = api.storage.session || api.storage.local;

api.action.onClicked.addListener((tab) => {
  api.tabs
    .sendMessage(tab.id, { type: "VITAL_OPEN_PANEL" })
    .catch(console.error);
});

api.runtime.onMessage.addListener((message, sender) => {
  if (!sender.tab) {
    return;
  }
  if (message.type === "VITAL_CHECK_SELECTION") {
    return state
      .set({ pendingSelection: { ...message.payload, tabId: sender.tab.id } })
      .then(() =>
        api.tabs.sendMessage(sender.tab.id, { type: "VITAL_OPEN_PANEL" }),
      );
  }
  if (message.type === "VITAL_CLAIM_SELECTED") {
    return state
      .set({ pendingClaim: { claimId: message.claimId, tabId: sender.tab.id } })
      .then(() =>
        api.tabs.sendMessage(sender.tab.id, { type: "VITAL_OPEN_PANEL" }),
      );
  }
});
