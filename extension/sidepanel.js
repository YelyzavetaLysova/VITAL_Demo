const DEFAULT_API = 'http://127.0.0.1:8765';

const views = ['start', 'loading', 'error', 'results'];

const statusColors = {
  supported: '#16856c',
  contradicted: '#d94b4b',
  mixed: '#d88815',
  context_needed: '#d88815',
  insufficient: '#687086'
};

let activeTabId;
let currentAnalysis;
let consumingSelection = false;


function show(name) {
  views.forEach((id) => {
    document.querySelector(`#${id}`).hidden = id !== name;
  });
}


function pct(value) {
  if (value == null) {
    return 'Not available';
  }

  return `${Math.round(value * 100)}%`;
}


function displayValue(value) {
  if (value == null || value === '') {
    return 'Not available';
  }

  return String(value);
}


function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value || '';
  return div.innerHTML;
}


async function getActiveTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  activeTabId = tab?.id;

  if (!activeTabId) {
    throw new Error('Open a web page before scanning.');
  }

  return tab;
}


/*
 * Send the analysis request directly from the persistent side panel.
 *
 * Previously, this request passed through the Manifest V3 background
 * service worker. Chrome could stop that worker during a long model run,
 * closing the message channel before the result was returned.
 */
async function requestAnalysis(payload) {
  const saved = await chrome.storage.local.get({
    apiBase: DEFAULT_API
  });

  const apiBase = saved.apiBase.replace(/\/$/, '');

  const response = await fetch(`${apiBase}/v1/analyse/jobs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));

    throw new Error(
      body.detail || `VITAL API returned HTTP ${response.status}.`
    );
  }

  const created = await response.json();

  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const statusResponse = await fetch(
      `${apiBase}/v1/analyse/jobs/${created.job_id}`
    );

    if (!statusResponse.ok) {
      const body = await statusResponse.json().catch(() => ({}));
      throw new Error(
        body.detail || `VITAL job status returned HTTP ${statusResponse.status}.`
      );
    }

    const job = await statusResponse.json();
    updateProgress(job);

    if (job.status === 'completed') {
      const data = job.result;

      await chrome.storage.session.set({
        lastAnalysis: data
      });

      return data;
    }

    if (job.status === 'failed') {
      throw new Error(job.error || 'The VITAL analysis job failed.');
    }
  }
}


function updateProgress(job) {
  const stage = document.querySelector('#progressStage');
  const elapsed = document.querySelector('#progressElapsed');
  const claims = document.querySelector('#progressClaims');

  stage.textContent = job.message || 'Analysis is running.';
  elapsed.textContent = `Elapsed time: ${formatDuration(job.elapsed_seconds)}`;

  if (job.total_claims != null) {
    claims.textContent =
      `Evidence checks: ${job.completed_claims} of ${job.total_claims}`;
    claims.hidden = false;
  } else {
    claims.hidden = true;
  }
}


function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  const minutes = Math.floor(total / 60);
  const remainingSeconds = total % 60;

  if (minutes === 0) {
    return `${remainingSeconds}s`;
  }

  return `${minutes}m ${String(remainingSeconds).padStart(2, '0')}s`;
}


async function scan(selectionPayload = null) {
    show('loading');

  document.querySelector('#progressStage').textContent =
    'Preparing the article for analysis.';
  document.querySelector('#progressElapsed').textContent =
    'Elapsed time: 0s';
  document.querySelector('#progressClaims').hidden = true;

  try {
    const tab = await getActiveTab();

    const payload =
      selectionPayload ||
      await chrome.tabs.sendMessage(tab.id, {
        type: 'VITAL_EXTRACT_PAGE'
      });

    if (!payload?.text || payload.text.length < 12) {
      throw new Error(
        'VITAL could not find enough article text on this page.'
      );
    }

    const data = await requestAnalysis(payload);

    render(data);

    await chrome.tabs.sendMessage(tab.id, {
      type: 'VITAL_HIGHLIGHT',
      claims: data.claims
    });
  } catch (error) {
    document.querySelector('#errorText').textContent =
      error?.message || 'VITAL could not complete the scan.';

    show('error');
  }
}


function switchView(viewId) {
  document.querySelectorAll('.main-tabs button').forEach((button) => {
    button.classList.toggle(
      'active',
      button.dataset.view === viewId
    );
  });

  document.querySelectorAll('.view').forEach((view) => {
    view.hidden = view.id !== viewId;
  });
}


function selectClaim(claimId, focusArticle = false) {
  if (!currentAnalysis) {
    return;
  }

  const index = currentAnalysis.claims.findIndex(
    (claim) => claim.id === claimId
  );

  if (index < 0) {
    return;
  }

  switchView('claimsView');

  document.querySelectorAll('.claim-card').forEach((card) => {
    const selected = card.dataset.claimId === claimId;

    card.classList.toggle('selected', selected);

    if (selected) {
      card.classList.remove('collapsed');

      card.scrollIntoView({
        behavior: 'smooth',
        block: 'start'
      });
    }
  });

  document.querySelectorAll('.claim-chip').forEach((chip) => {
    chip.classList.toggle(
      'active',
      chip.dataset.claimId === claimId
    );
  });

  document.querySelector('#claimPosition').textContent =
    `Viewing ${index + 1} of ${currentAnalysis.claims.length}`;

  if (focusArticle && activeTabId) {
    chrome.tabs.sendMessage(activeTabId, {
      type: 'VITAL_FOCUS_CLAIM',
      claimId
    });
  }
}


function render(data) {
  currentAnalysis = data;

  const claims = data.claims || [];
  const warnings = data.warnings || [];

  document.querySelector('#resultCount').textContent =
    `${claims.length} health claim${claims.length === 1 ? '' : 's'} found`;

  document.querySelector('#modeLabel').textContent =
    data.mode === 'live'
      ? 'Live evidence analysis'
      : 'Local demonstration mode';

  document.querySelector('#warnings').innerHTML = warnings
    .map((text) => {
      return `<div class="warning">${escapeHtml(text)}</div>`;
    })
    .join('');

  const list = document.querySelector('#claimList');
  const chips = document.querySelector('#claimChips');

  list.innerHTML = '';
  chips.innerHTML = '';

  claims.forEach((claim, index) => {
    list.append(buildClaim(claim, index));

    const chip = document.createElement('button');

    chip.className = 'claim-chip';
    chip.dataset.claimId = claim.id;
    chip.style.setProperty(
      '--status-color',
      statusColors[claim.status] || statusColors.insufficient
    );

    chip.innerHTML = `<i></i>${index + 1}`;
    chip.title = `${claim.status_label}: ${claim.text}`;

    chip.addEventListener('click', () => {
      selectClaim(claim.id, true);
    });

    chips.append(chip);
  });

  if (!claims.length) {
    list.innerHTML = `
      <div class="warning">
        No likely health claims were found in the extracted article text.
      </div>
    `;
  }

  renderArticle(data.article || {});
  switchView('claimsView');
  show('results');

  if (claims[0]) {
    setTimeout(() => {
      selectClaim(claims[0].id, false);
    }, 0);
  }
}


function buildClaim(claim, index) {
  const template = document.querySelector('#claimTemplate');
  const node = template.content.firstElementChild.cloneNode(true);

  node.dataset.claimId = claim.id;

  node.style.setProperty(
    '--status-color',
    statusColors[claim.status] || statusColors.insufficient
  );

  if (index > 0) {
    node.classList.add('collapsed');
  }

  node.querySelector('.claim-number').textContent =
    String(index + 1).padStart(2, '0');

  node.querySelector('.status').textContent =
    claim.status_label;

  node.querySelector('.claim-preview').textContent =
    claim.text;

  node.querySelector('blockquote').textContent =
    `“${claim.text}”`;

  node.querySelector('.explanation').textContent =
    claim.explanation;

  node.querySelector('.factiverse-raw').textContent =
    JSON.stringify(claim.factiverse || {}, null, 2);

  const resolvedClaim = node.querySelector('.resolved-claim');

  if (claim.resolved_claim) {
    resolvedClaim.textContent = `Resolved claim: ${claim.resolved_claim}`;
    resolvedClaim.hidden = false;
  }

  node.querySelector('.detection').textContent =
    pct(claim.detection_score);

  node.querySelector('.checkworthiness').textContent =
    displayValue(claim.checkworthiness);

  node.querySelector('.final-score').textContent =
    pct(claim.final_score);

  node.querySelector('.evidence-count').textContent =
    claim.evidence?.length || 0;

  const statusIcons = {
    supported: '✓',
    contradicted: '×',
    mixed: '≈',
    context_needed: '!',
    insufficient: '?'
  };

  node.querySelector('.status-icon').textContent =
    statusIcons[claim.status] || '?';

  node.querySelector('.evidence-list').innerHTML =
    (claim.evidence || [])
      .map((item) => {
        return `
          <div class="evidence-item">
            <a
              href="${escapeHtml(item.url || '#')}"
              target="_blank"
              rel="noopener noreferrer"
            >
              ${escapeHtml(item.title)}
            </a>

            <p>
              ${escapeHtml(
                item.passage ||
                'Open the source to inspect the evidence.'
              )}
            </p>

            <div class="evidence-meta">
              <span>${escapeHtml(item.stance)}</span>
              ${item.stance_score == null ? '' : `<span>Stance ${pct(item.stance_score)}</span>`}
              ${item.similarity_score == null ? '' : `<span>Similarity ${pct(item.similarity_score)}</span>`}
              ${item.exact_match == null ? '' : `<span>${item.exact_match ? 'Exact match' : 'Related match'}</span>`}
            </div>

            <div class="source-context">
              ${item.publisher ? `<span>Source: ${escapeHtml(item.publisher)}</span>` : ''}
              ${item.date ? `<span>Published: ${escapeHtml(item.date)}</span>` : ''}
              ${item.reliability ? `<span>Reliability: ${escapeHtml(item.reliability)}</span>` : ''}
              ${item.bias ? `<span>Bias: ${escapeHtml(item.bias)}</span>` : ''}
              ${item.trust_score == null ? '' : `<span>Trust score: ${escapeHtml(String(item.trust_score))}</span>`}
              ${item.citation_count == null ? '' : `<span>Citations: ${escapeHtml(String(item.citation_count))}</span>`}
            </div>

            <details class="factiverse-details">
              <summary>Factiverse evidence details</summary>
              <dl>
                <div><dt>Search service</dt><dd>${escapeHtml(displayValue(item.source_type))}</dd></div>
                <div><dt>Language</dt><dd>${escapeHtml(displayValue(item.language))}</dd></div>
                <div><dt>Preferred source</dt><dd>${item.preferred_site == null ? 'Not available' : item.preferred_site ? 'Yes' : 'No'}</dd></div>
                <div><dt>Predicted label</dt><dd>${escapeHtml(displayValue(item.predicted_label))}</dd></div>
                <div><dt>Authors</dt><dd>${escapeHtml((item.authors || []).join(', ') || 'Not available')}</dd></div>
                <div><dt>Original query</dt><dd>${escapeHtml(displayValue(item.original_query))}</dd></div>
                <div><dt>Rewritten query</dt><dd>${escapeHtml(displayValue(item.rewritten_query))}</dd></div>
                <div><dt>Translated</dt><dd>${item.translated == null ? 'Not available' : item.translated ? 'Yes' : 'No'}</dd></div>
                <div><dt>Translated query</dt><dd>${escapeHtml(displayValue(item.translated_query))}</dd></div>
                <div><dt>Detailed label</dt><dd>${escapeHtml(displayValue(item.detailed_label))}</dd></div>
                <div><dt>Class probabilities</dt><dd>${escapeHtml((item.softmax_score || []).join(', ') || 'Not available')}</dd></div>
                <div><dt>Keywords</dt><dd>${escapeHtml((item.keywords || []).join(', ') || 'Not available')}</dd></div>
              </dl>
              ${item.bias_source_url ? `<a href="${escapeHtml(item.bias_source_url)}" target="_blank" rel="noopener noreferrer">Bias metadata source</a>` : ''}
              ${item.trust_score_source ? `<a href="${escapeHtml(item.trust_score_source)}" target="_blank" rel="noopener noreferrer">Trust-score source</a>` : ''}
            </details>
          </div>
        `;
      })
      .join('');

  node.querySelector('.claim-head').addEventListener(
    'click',
    () => {
      selectClaim(claim.id, true);
    }
  );

  node.querySelector('.locate-claim').addEventListener(
    'click',
    () => {
      selectClaim(claim.id, true);
    }
  );

  return node;
}


async function consumePendingSelection() {
  if (consumingSelection) {
    return false;
  }

  consumingSelection = true;

  const { pendingSelection } = await chrome.storage.session.get(
    'pendingSelection'
  );

  if (!pendingSelection) {
    consumingSelection = false;
    return false;
  }

  await chrome.storage.session.remove('pendingSelection');

  try {
    await scan(pendingSelection);
  } finally {
    consumingSelection = false;
  }

  return true;
}


function renderArticle(article) {
  renderTopics(article);
  renderAdvertorial(article);
  renderSentiment(article);
  renderProvider(article);
}


function renderTopics(article) {
  const topics = document.querySelector('#topics');
  const results = article.topics || [];

  topics.innerHTML = '';

  results.forEach((topic) => {
    topics.insertAdjacentHTML(
      'beforeend',
      `
        <div class="topic">
          <span>${escapeHtml(topic.label)}</span>
          <strong>${pct(topic.score)}</strong>

          <div class="topic-bar">
            <i style="width: ${pct(topic.score)}"></i>
          </div>
        </div>
      `
    );
  });

  document.querySelector('[data-empty="topics"]').hidden =
    results.length > 0;
}


function renderAdvertorial(article) {
  const container = document.querySelector('#advertorial');

  container.innerHTML = '';

  if (article.advertorial) {
    container.innerHTML = `
      <div class="metric-card">
        <div>
          <span>Classification</span>
          <strong>
            ${escapeHtml(article.advertorial.label)}
          </strong>
        </div>

        <div>
          <span>Model confidence</span>
          <strong>${pct(article.advertorial.score)}</strong>
        </div>

        <p>
          This is a model classification, not a definitive finding
          of undisclosed advertising.
        </p>
      </div>
    `;
  }

  document.querySelector('[data-empty="advertorial"]').hidden =
    Boolean(article.advertorial);
}


function renderSentiment(article) {
  const container = document.querySelector('#sentiment');

  container.innerHTML = '';

  const hasSentiment =
    article.title_sentiment &&
    article.content_sentiment;

  if (hasSentiment) {
    container.innerHTML = `
      <div class="sentiment-grid">
        <div>
          <small>Headline</small>
          <strong>
            ${escapeHtml(article.title_sentiment.label)}
          </strong>
          <small>${pct(article.title_sentiment.score)}</small>
        </div>

        <div>
          <small>Article body</small>
          <strong>
            ${escapeHtml(article.content_sentiment.label)}
          </strong>
          <small>${pct(article.content_sentiment.score)}</small>
        </div>
      </div>

      <div class="framing">
        ${escapeHtml(article.framing_difference || '')}
      </div>
    `;
  }

  document.querySelector('[data-empty="sentiment"]').hidden =
    Boolean(hasSentiment);
}


function renderProvider(article) {
  const container = document.querySelector('#provider');

  container.innerHTML = '';

  if (article.provider) {
    container.innerHTML = `
      <div class="provider-grid">
        <div>
          <small>Publisher</small>
          <strong>
            ${escapeHtml(
              article.provider.name || article.provider.domain
            )}
          </strong>
        </div>

        <div>
          <small>Domain</small>
          <strong>
            ${escapeHtml(article.provider.domain)}
          </strong>
        </div>

        <div>
          <small>Credibility</small>
          <strong>
            ${escapeHtml(
              String(
                article.provider.credibility ?? 'Not rated'
              )
            )}
          </strong>
        </div>

        <div>
          <small>Bias</small>
          <strong>
            ${escapeHtml(
              article.provider.bias || 'Not rated'
            )}
          </strong>
        </div>
      </div>
    `;
  }

  document.querySelector('[data-empty="provider"]').hidden =
    Boolean(article.provider);
}


/*
 * Interface event handlers
 */

document
  .querySelectorAll('.main-tabs button')
  .forEach((button) => {
    button.addEventListener('click', () => {
      switchView(button.dataset.view);
    });
  });


document.querySelector('#scan').addEventListener('click', () => {
  scan();
});


document.querySelector('#rescan').addEventListener('click', () => {
  scan();
});


document.querySelector('#retry').addEventListener('click', () => {
  scan();
});


document
  .querySelector('#settings')
  .addEventListener('click', async () => {
    const saved = await chrome.storage.local.get({
      apiBase: DEFAULT_API
    });

    document.querySelector('#apiBase').value =
      saved.apiBase;

    document
      .querySelector('#settingsDialog')
      .showModal();
  });


document
  .querySelector('#saveSettings')
  .addEventListener('click', async () => {
    const apiBase = document
      .querySelector('#apiBase')
      .value
      .trim()
      .replace(/\/$/, '');

    await chrome.storage.local.set({
      apiBase: apiBase || DEFAULT_API
    });
  });


/*
 * Messages originating from article highlights or selection actions.
 */

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'VITAL_CLAIM_SELECTED') {
    selectClaim(message.claimId, false);
  }

  if (message.type === 'VITAL_SELECTION_READY') {
    consumePendingSelection();
  }

  if (message.type === 'VITAL_ANALYSIS_READY') {
    render(message.result.data);

    getActiveTab()
      .then((tab) => {
        return chrome.tabs.sendMessage(tab.id, {
          type: 'VITAL_HIGHLIGHT',
          claims: message.result.data.claims
        });
      })
      .catch(() => {});
  }

  if (message.type === 'VITAL_ANALYSIS_ERROR') {
    document.querySelector('#errorText').textContent =
      message.error;

    show('error');
  }
});


/*
 * Restore the most recent completed result when the side panel reopens.
 */

async function initialisePanel() {
  const consumedSelection = await consumePendingSelection();

  if (consumedSelection) {
    return;
  }

  const { lastAnalysis } = await chrome.storage.session.get(
    'lastAnalysis'
  );

  if (lastAnalysis) {
    render(lastAnalysis);
  }
}


initialisePanel();
