let lastArticle = null;
let selectionButton = null;

function articleRoot() {
  return document.querySelector('article') || document.querySelector('main') || document.body;
}

function extractPage() {
  const root = articleRoot();
  const blocks = [...root.querySelectorAll('h1,h2,h3,p,li,blockquote')]
    .filter(el => !el.closest('nav,footer,aside,[aria-hidden="true"]'));
  const text = blocks.map(el => el.innerText.trim()).filter(Boolean).join('\n\n').slice(0, 120000);
  const headline = root.querySelector('h1')?.innerText.trim() || document.title;
  lastArticle = { url: location.href, title: headline, text, language: document.documentElement.lang || 'en' };
  return lastArticle;
}

function clearHighlights() {
  document.querySelectorAll('.vital-claim-highlight').forEach(mark => mark.replaceWith(document.createTextNode(mark.textContent)));
  articleRoot().normalize();
}

function highlightClaim(claim) {
  const root = articleRoot();
  const needle = claim.text.trim().toLowerCase();
  const blocks = [...root.querySelectorAll('h1,h2,h3,p,li,blockquote')];
  for (const block of blocks) {
    if (block.closest('nav,footer,.vital-claim-highlight')) continue;
    const nodes = [];
    const walker = document.createTreeWalker(
      block,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          return node.nodeValue
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        }
      }
    );
    let textNode;
    let combined = '';

    while ((textNode = walker.nextNode())) {
      nodes.push({
        node: textNode,
        start: combined.length,
        end: combined.length + textNode.nodeValue.length
      });
      combined += textNode.nodeValue;
    }

    const index = combined.toLowerCase().indexOf(needle);
    if (index < 0) continue;

    const finish = index + claim.text.length;
    const startPart = nodes.find(
      part => index >= part.start && index < part.end
    );
    const endPart = nodes.find(
      part => finish > part.start && finish <= part.end
    );
    if (!startPart || !endPart) continue;
    const range = document.createRange();
    range.setStart(startPart.node,index-startPart.start);range.setEnd(endPart.node,finish-endPart.start);
    const mark = document.createElement('mark');
    mark.className = 'vital-claim-highlight';
    mark.dataset.vitalClaimId = claim.id;
    mark.dataset.vitalStatus = claim.status;
    mark.title = `${claim.status_label} — open VITAL for evidence`;
    mark.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'VITAL_CLAIM_SELECTED', claimId: claim.id }));
    try {
      mark.append(range.extractContents());
      range.insertNode(mark);
    } catch (_error) {
      continue;
    }
    return true;
  }
  return false;
}

function showSelectionAction(selection) {
  selectionButton?.remove();
  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  selectionButton = document.createElement('button');
  selectionButton.className = 'vital-selection-button';
  selectionButton.textContent = 'Check with VITAL';
  selectionButton.style.left = `${Math.min(innerWidth - 155, Math.max(8, rect.left + rect.width / 2 - 75))}px`;
  selectionButton.style.top = `${Math.max(8, rect.top - 48)}px`;
  selectionButton.addEventListener('mousedown', event => {
    event.preventDefault();
    const selectedText = selection.toString().trim();
    chrome.runtime.sendMessage({ type: 'VITAL_CHECK_SELECTION', payload: { ...extractPage(), selected_text: selectedText } });
    selection.removeAllRanges();
    selectionButton.remove();
  });
  document.body.appendChild(selectionButton);
}

document.addEventListener('selectionchange', () => {
  const selection = getSelection();
  const text = selection?.toString().trim();
  if (text?.length >= 12 && articleRoot().contains(selection.anchorNode)) showSelectionAction(selection);
  else selectionButton?.remove();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'VITAL_EXTRACT_PAGE') {
    sendResponse(extractPage());
    return;
  }
  if (message.type === 'VITAL_HIGHLIGHT') {
    clearHighlights();
    sendResponse({ highlighted: message.claims.filter(highlightClaim).length });
  }
  if (message.type === 'VITAL_FOCUS_CLAIM') {
    const selector = `[data-vital-claim-id="${CSS.escape(message.claimId)}"]`;
    const mark = document.querySelector(selector);

    document.querySelectorAll('.vital-focused').forEach(item => {
      item.classList.remove('vital-focused');
    });

    if (mark) {
      mark.classList.add('vital-focused');
      mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => mark.classList.remove('vital-focused'), 1800);
    }

    sendResponse({ found: Boolean(mark) });
  }
});
