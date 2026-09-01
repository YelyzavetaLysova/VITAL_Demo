chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'VITAL_CHECK_SELECTION' && _sender.tab) {
    const windowId = _sender.tab.windowId;
    chrome.storage.session
      .set({ pendingSelection: message.payload })
      .then(() => chrome.sidePanel.open({ windowId }))
      .then(() => chrome.runtime.sendMessage({ type: 'VITAL_SELECTION_READY' }))
      .catch(console.error);
    sendResponse({ accepted: true });
    return true;
  }
  if (message.type === 'VITAL_CLAIM_SELECTED' && _sender.tab) {
    chrome.sidePanel.open({ windowId: _sender.tab.windowId })
      .then(() => chrome.runtime.sendMessage({ type: 'VITAL_CLAIM_SELECTED', claimId: message.claimId }))
      .catch(console.error);
    sendResponse({ accepted: true });
    return true;
  }
  return false;
});
