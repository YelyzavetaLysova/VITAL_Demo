"use strict";
const api = globalThis.browser || globalThis.chrome;
async function openPanel(tab) {
  if (!tab?.id || !/^https?:/.test(tab.url || "")) return;
  try {
    await api.tabs.sendMessage(tab.id, {
      type: "VITAL_OPEN_PANEL",
      toggle: true,
      tabId: tab.id,
    });
  } catch {
    await api.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["mention-navigation.js", "content-script.js"],
    });
    await api.scripting.insertCSS({
      target: { tabId: tab.id },
      files: ["content.css"],
    });
    await api.tabs.sendMessage(tab.id, {
      type: "VITAL_OPEN_PANEL",
      toggle: true,
      tabId: tab.id,
    });
  }
}
api.action.onClicked.addListener((tab) => openPanel(tab).catch(console.error));
api.runtime.onMessage.addListener((message, sender, reply) => {
  if (
    message.type === "VITAL_CLOSE_PANEL" &&
    sender.url?.startsWith(api.runtime.getURL("")) &&
    Number.isInteger(message.tabId)
  ) {
    api.tabs
      .sendMessage(message.tabId, { type: "VITAL_CLOSE_PANEL" })
      .catch(() => {});
    reply({ accepted: true });
  }
  if (message.type === "VITAL_CLAIM_SELECTED" && sender.tab) {
    api.storage.local
      .set({ ["pendingClaim:" + sender.tab.id]: message.claimId })
      .then(() =>
        api.tabs.sendMessage(sender.tab.id, {
          type: "VITAL_OPEN_PANEL",
          tabId: sender.tab.id,
        }),
      )
      .then(() => api.runtime.sendMessage({ ...message, tabId: sender.tab.id }))
      .catch(console.error);
    reply({ accepted: true });
  }
  return false;
});
