(() => {
  if (globalThis.__vitalContentInstalled) return;
  globalThis.__vitalContentInstalled = true;
  const chrome = globalThis.browser || globalThis.chrome;
  let panelHost, panelFrame, returnFocus;
  function closePanel() {
    panelHost?.setAttribute("hidden", "");
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  }
  function openPanel(tabId, toggle = false) {
    returnFocus = document.activeElement;
    if (panelHost) {
      if (toggle && !panelHost.hidden) {
        closePanel();
        return;
      }
      panelHost.removeAttribute("hidden");
      panelFrame.focus();
      return;
    }
    panelHost = document.createElement("div");
    panelHost.id = "vital-demo-panel";
    const shadow = panelHost.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `:host { all:initial; position:fixed; inset:12px 12px 12px auto; width:min(440px,calc(100vw - 24px)); z-index:2147483647; box-shadow:0 12px 48px #14251d38; border-radius:14px; overflow:hidden; } :host([hidden]) { display:none !important; } iframe { display:block; border:0; width:100%; height:100%; background:white; } @media(max-width:760px) { :host { inset:auto 0 0 0; width:100%; height:82dvh; border-radius:18px 18px 0 0; padding-bottom:env(safe-area-inset-bottom); background:white; } }`;
    panelFrame = document.createElement("iframe");
    panelFrame.src =
      chrome.runtime.getURL("sidepanel.html") +
      "#tab=" +
      tabId +
      "&mobile=" +
      (innerWidth <= 760 ? "1" : "0");
    panelFrame.title = "VITAL by MediaFutures";
    shadow.append(style, panelFrame);
    document.documentElement.append(panelHost);
    panelFrame.addEventListener("load", () => panelFrame.focus());
  }
  window.addEventListener("message", (event) => {
    if (event.source !== panelFrame?.contentWindow) return;
    if (event.data?.type === "VITAL_FRAME_CLOSE") closePanel();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && panelHost && !panelHost.hidden) {
      event.preventDefault();
      closePanel();
    }
  });
  window.addEventListener("resize", () => {
    panelFrame?.contentWindow?.postMessage(
      { type: "VITAL_HOST_VIEWPORT", mobile: innerWidth <= 760 },
      "*",
    );
  });
  let lastSelectedText = "";

  const blockSelector = "h1,h2,h3,p,li,blockquote";
  const excludedSelector =
    'nav,footer,aside,#vital-demo-panel,[aria-hidden="true"],script,style,[hidden],.advertisement,.ad-slot';

  function articleRoot() {
    const candidates = [
      ...document.querySelectorAll(
        '[itemprop="articleBody"],.article__content,.article-body,.article-content,article,main,[role="main"]',
      ),
    ];
    const readableLength = (root) =>
      [...root.querySelectorAll("p,blockquote")]
        .filter((node) => !node.closest(excludedSelector))
        .reduce(
          (total, node) =>
            total + (node.innerText || node.textContent || "").length,
          0,
        );
    candidates.sort((a, b) => readableLength(b) - readableLength(a));
    return candidates[0] && readableLength(candidates[0]) >= 12
      ? candidates[0]
      : document.body;
  }

  function articleBlocks(root) {
    return [...root.querySelectorAll(blockSelector)]
      .filter((node) => !node.closest(excludedSelector))
      .filter((node) => !node.parentElement.closest("li,blockquote"));
  }

  function extractPage() {
    const root = articleRoot();
    const text = articleBlocks(root)
      .map((node) => (node.innerText || node.textContent || "").trim())
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 120000);
    return {
      url: location.href,
      title: root.querySelector("h1")?.textContent.trim() || document.title,
      text,
      language: (document.documentElement.lang || "en").split("-")[0],
      publisher:
        document.querySelector('meta[property="og:site_name"]')?.content ||
        location.hostname,
      published_at:
        document.querySelector('meta[property="article:published_time"]')
          ?.content || "",
    };
  }

  function clearHighlights() {
    document.querySelectorAll(".vital-claim-highlight").forEach((mark) => {
      // Preserve original inline links and formatting when removing a highlight.
      mark.replaceWith(...mark.childNodes);
    });
    articleRoot().normalize();
  }

  function normalisedText(text) {
    const positions = [];
    let value = "";
    for (let index = 0; index < text.length; index++) {
      const char = /\s/.test(text[index]) ? " " : text[index].toLowerCase();
      if (char === " " && value.endsWith(" ")) continue;
      positions.push(index);
      value += char;
    }
    return { value, positions };
  }

  function highlightClaim(claim) {
    const needle = normalisedText(claim.text.trim()).value;
    if (!needle) return false;
    for (const block of articleBlocks(articleRoot())) {
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      const nodes = [];
      let combined = "";
      let current;
      while ((current = walker.nextNode())) {
        nodes.push({
          node: current,
          start: combined.length,
          end: combined.length + current.nodeValue.length,
        });
        combined += current.nodeValue;
      }
      const normalised = normalisedText(combined);
      const match = normalised.value.indexOf(needle);
      if (match < 0) continue;
      const start = normalised.positions[match];
      const finish = normalised.positions[match + needle.length - 1] + 1;
      const startPart = nodes.find(
        (part) => start >= part.start && start < part.end,
      );
      const endPart = nodes.find(
        (part) => finish > part.start && finish <= part.end,
      );
      if (!startPart || !endPart) continue;
      if (
        nodes.some(
          (part) =>
            part.end > start &&
            part.start < finish &&
            part.node.parentElement.closest(".vital-claim-highlight"),
        )
      )
        continue;
      const range = document.createRange();
      range.setStart(startPart.node, start - startPart.start);
      range.setEnd(endPart.node, finish - endPart.start);
      const mark = document.createElement("mark");
      mark.className = "vital-claim-highlight";
      mark.dataset.vitalClaimId = claim.id;
      mark.dataset.vitalStatus = claim.status;
      const statusLabel =
        {
          pending: "Not Health Claim",
          skipped: "Not Health Claim",
          checking: "Checking",
          supported: "Supported",
          contradicted: "Contradicted",
          mixed: "Mixed evidence",
          context_needed: "Context needed",
          insufficient: "Insufficient evidence",
          error: "Check failed",
        }[claim.status] || claim.status_label;
      mark.title = `${statusLabel}. Open VITAL for evidence.`;
      mark.tabIndex = 0;
      mark.setAttribute("role", "button");
      mark.setAttribute("aria-label", `${statusLabel}. Open claim in VITAL.`);
      mark.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        chrome.runtime
          .sendMessage({ type: "VITAL_CLAIM_SELECTED", claimId: claim.id })
          .catch(console.error);
      });
      mark.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          mark.click();
        }
      });
      try {
        mark.append(range.extractContents());
        range.insertNode(mark);
        return true;
      } catch {
        // Some site DOM structures cannot be safely wrapped.
      }
    }
    return false;
  }

  document.addEventListener("selectionchange", () => {
    const selection = getSelection();
    if (
      selection?.toString().trim().length >= 12 &&
      articleRoot().contains(selection.anchorNode)
    ) {
      lastSelectedText = selection.toString().trim();
    }
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "VITAL_OPEN_PANEL") {
      openPanel(message.tabId, Boolean(message.toggle));
      sendResponse({ opened: true });
    }
    if (message.type === "VITAL_CLOSE_PANEL") {
      closePanel();
      sendResponse({ closed: true });
    }
    if (message.type === "VITAL_FIND_MENTION")
      sendResponse(
        vitalFindMention(articleRoot(), message.term, message.detail || {}),
      );
    if (message.type === "VITAL_EXTRACT_PAGE") sendResponse(extractPage());
    if (message.type === "VITAL_GET_SELECTION") {
      const selectedText =
        getSelection()?.toString().trim() || lastSelectedText || "";
      sendResponse({ selected_text: selectedText });
    }
    if (message.type === "VITAL_HIGHLIGHT") {
      clearHighlights();
      sendResponse({
        highlighted: message.claims.filter(highlightClaim).length,
      });
    }
    if (message.type === "VITAL_FOCUS_CLAIM") {
      const mark = document.querySelector(
        `[data-vital-claim-id="${CSS.escape(message.claimId)}"]`,
      );
      document
        .querySelectorAll(".vital-focused")
        .forEach((node) => node.classList.remove("vital-focused"));
      if (mark) {
        mark.classList.add("vital-focused");
        mark.scrollIntoView({ behavior: "smooth", block: "center" });
        setTimeout(() => mark.classList.remove("vital-focused"), 1800);
      }
      sendResponse({ found: Boolean(mark) });
    }
    return false;
  });
})();
