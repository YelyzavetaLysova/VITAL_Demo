/* Extension-origin iframe keeps requests alive while the article is clicked. */
chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== "VITAL_OPEN_PANEL") {
    return;
  }
  let panel = document.getElementById("vital-demo-panel");
  if (panel) {
    panel.style.display = "grid";
    return;
  }
  panel = document.createElement("div");
  panel.id = "vital-demo-panel";
  panel.style.cssText =
    "position:fixed;right:0;top:0;width:min(480px,100vw);height:100dvh;z-index:2147483647;background:#f8f9fa;box-shadow:-8px 0 28px #0003;display:grid;grid-template-rows:44px minmax(0,1fr);border-left:1px solid #dce1e5;";
  const close = document.createElement("button");
  close.textContent = "Close ×";
  close.style.cssText =
    "all:initial;box-sizing:border-box;display:block;text-align:right;padding:8px 16px;color:#20272d;font:13px -apple-system,BlinkMacSystemFont,sans-serif;cursor:pointer;min-height:44px;";
  close.addEventListener("click", () => {
    panel.style.display = "none";
  });
  const frame = document.createElement("iframe");
  frame.src = chrome.runtime.getURL("sidepanel.html");
  frame.title = "VITAL · MediaFutures";
  frame.style.cssText = "border:0;width:100%;height:100%;min-height:0;";
  panel.append(close, frame);
  document.body.append(panel);
});
