"use strict";
const api = globalThis.browser || globalThis.chrome;
api.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.type !== "VITAL_CLAIM_SELECTED" || !sender.tab) return false;
  // Save before opening: a toolbar popup may not exist yet to receive messages.
  api.storage.local.set({ ["pendingClaim:" + sender.tab.id]: message.claimId })
    .then(async () => {
      try { await api.runtime.sendMessage({ ...message, tabId: sender.tab.id }); } catch {}
      try {
        if (api.action.openPopup) await api.action.openPopup();
      } catch {
        // Safari may require the toolbar button. The saved claim opens next time.
      }
    }).catch(console.error);
  reply({ accepted: true });
  return false;
});
