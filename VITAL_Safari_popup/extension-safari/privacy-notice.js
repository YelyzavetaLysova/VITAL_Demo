"use strict";

// Keep acknowledgement separate from article submission. No content leaves the
// browser through this interface until a protected action is accepted.
globalThis.vitalPrivacy = (() => {
  const version = "2026-10-28.1";
  const key = "vital-privacy-acknowledgement";
  const isExtension = typeof VITAL_BACKEND_URL !== "undefined";
  const extension = globalThis.browser || globalThis.chrome;
  let acknowledged = false;
  let pending = null;
  let opener;
  const read = async () => {
    try {
      if (isExtension) return (await extension.storage.local.get(key))[key];
      return localStorage.getItem(key);
    } catch { return null; }
  };
  const write = async (value) => {
    if (isExtension) await extension.storage.local.set({ [key]: value });
    else localStorage.setItem(key, value);
  };
  const ready = read().then((value) => { try {
      const saved = JSON.parse(value || "null");
      acknowledged = saved?.version === version;
    } catch { acknowledged = false; } });

  function hide(value) {
    const layer = document.querySelector("#privacyNotice");
    layer.hidden = true;
    document.body.classList.remove("privacy-open");
    opener?.focus();
    const resolve = pending?.resolve;
    pending = null;
    resolve?.(value);
  }

  async function ensure() {
    await ready;
    if (acknowledged) return true;
    if (pending) return pending.promise;
    const layer = document.querySelector("#privacyNotice");
    opener = document.activeElement;
    layer.hidden = false;
    document.body.classList.add("privacy-open");
    const promise = new Promise((resolve) => { pending = { resolve }; });
    pending.promise = promise;
    document.querySelector("#privacyAccept").focus();
    return promise;
  }

  function status() {
    const text = document.querySelector("#privacyStatus");
    if (text) text.textContent = acknowledged
      ? "Notice accepted on this browser."
      : "Accept the notice before submitting content or feedback.";
  }

  async function withdraw() {
    await ready;
    acknowledged = false;
    await write("");
    status();
    document.dispatchEvent(new Event("vital-privacy-withdrawn"));
  }

  document.querySelector("#privacyAccept").addEventListener("click", async () => {
    const error = document.querySelector("#privacyNoticeError");
    error.textContent = "";
    try {
      await write(JSON.stringify({ version, accepted_at: new Date().toISOString() }));
      acknowledged = true;
      status();
      hide(true);
    } catch {
      error.textContent = "Your choice could not be saved. Check browser storage access and try again.";
    }
  });
  document.querySelector("#privacyDecline").addEventListener("click", () => hide(false));
  document.querySelector("#privacyWithdraw").addEventListener("click", () => {
    withdraw().catch(() => {
      document.querySelector("#privacyStatus").textContent = "Could not save the change. Try again.";
    });
  });
  document.querySelector("#privacyNotice").addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); hide(false); }
    if (event.key === "Tab") {
      const items = [...event.currentTarget.querySelectorAll("button, a[href], summary")];
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  ready.then(status);
  return { ready, ensure, withdraw, version };
})();
