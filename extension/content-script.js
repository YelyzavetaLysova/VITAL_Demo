let selectionButton = null;

const blockSelector = "h1,h2,h3,p,li,blockquote";
const excludedSelector =
  'nav,footer,aside,#vital-demo-panel,[aria-hidden="true"]';

function articleRoot() {
  const candidates = [
    ...document.querySelectorAll('article,main,[role="main"]'),
  ];
  const readableLength = (root) =>
    [...root.querySelectorAll("p,blockquote")]
      .filter((node) => !node.closest(excludedSelector))
      .reduce((total, node) => total + (node.innerText || "").length, 0);
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
    .map((node) => node.innerText.trim())
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 120000);
  return {
    url: location.href,
    title: root.querySelector("h1")?.innerText.trim() || document.title,
    text,
    language: document.documentElement.lang || "en",
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
    mark.title = `${claim.status_label} — open VITAL for evidence`;
    mark.tabIndex = 0;
    mark.setAttribute("role", "button");
    mark.setAttribute(
      "aria-label",
      `${claim.status_label}. Open claim in VITAL.`,
    );
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

function showSelectionAction(selection) {
  selectionButton?.remove();
  if (!selection.rangeCount) return;
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  const selectedText = selection.toString().trim();
  selectionButton = document.createElement("button");
  selectionButton.className = "vital-selection-button";
  selectionButton.textContent = "Check with VITAL";
  selectionButton.style.left = `${Math.min(innerWidth - 155, Math.max(8, rect.left))}px`;
  selectionButton.style.top = `${Math.max(8, rect.top - 48)}px`;
  const checkSelection = (event) => {
    event.preventDefault();
    chrome.runtime
      .sendMessage({
        type: "VITAL_CHECK_SELECTION",
        payload: { ...extractPage(), selected_text: selectedText },
      })
      .catch(console.error);
    selection.removeAllRanges();
    selectionButton?.remove();
  };
  selectionButton.addEventListener("pointerdown", checkSelection);
  selectionButton.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") checkSelection(event);
  });
  document.body.append(selectionButton);
}

document.addEventListener("selectionchange", () => {
  const selection = getSelection();
  if (
    selection?.toString().trim().length >= 12 &&
    articleRoot().contains(selection.anchorNode)
  ) {
    showSelectionAction(selection);
  } else {
    selectionButton?.remove();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "VITAL_EXTRACT_PAGE") sendResponse(extractPage());
  if (message.type === "VITAL_HIGHLIGHT") {
    clearHighlights();
    sendResponse({ highlighted: message.claims.filter(highlightClaim).length });
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
