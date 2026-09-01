# VITAL practical browser version 0.3

This package contains a real Chrome Manifest V3 extension and a local FastAPI backend. It uses the supplied VITAL research pipeline’s existing Factiverse claim-detection and stance-detection contracts, but isolates them behind a stable application API.

## What works

- User-initiated extraction of readable page text.
- “Scan this page” from a Chrome side panel.
- Select text on a page and choose **Check with VITAL**.
- Live Factiverse claim detection and stance/evidence lookup when an API key is configured.
- Colour-coded claim highlighting and two-way article/side-panel navigation.
- Sticky numbered claim navigator and expandable claim list.
- Normalised verdicts plus the complete Factiverse claim and evidence payload.
- Real job progress with analysis phase, elapsed time and completed evidence checks.
- Factiverse confidence, similarity, exact-match, reliability, bias and trust metadata.
- Real health-topic, advertorial and title/body sentiment models when enabled.
- Real provider credibility lookup from the VITAL provider export.
- One-hour result cache, retry/backoff, explicit errors and demo fallback.
- No API secret or browsing-history permission in the extension.

## 1. Start the backend

Requires Python 3.11 or newer.

```bash
cd backend
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
```

Add the same Factiverse key used by the research notebook to `.env`:

```env
FACTIVERSE_API_KEY=your-real-key
```

Then run:

```bash
uvicorn app.main:app --host 127.0.0.1 --port 8765 --reload
```

Verify it at <http://127.0.0.1:8765/health>. API documentation is available at <http://127.0.0.1:8765/docs>.

Without a key, the API deliberately runs in demo mode: it identifies likely health sentences locally but does not invent evidence.

### Enable article-level models

The article models are real and intentionally optional because the DeBERTa model is large and can be slow on a laptop. Install them with:

```bash
pip install -r requirements-ml.txt
```

Then set this in `.env`:

```env
VITAL_ENABLE_ML=true
```

The first analysis downloads the configured Hugging Face models. VITAL uses the same `MoritzLaurer/deberta-v3-large-zeroshot-v1` model and 105-topic taxonomy as the supplied research notebook for health topics and advertorial classification. Sentiment uses the configured dedicated transformer model on the headline and article body separately.

### Add real provider metadata

Export the project provider table to `backend/data/providers.csv`. The lookup accepts these columns:

```csv
domain,name,credibility,bias,country
cnn.com,CNN,high,left-center,US
```

`domain` (or `url`) is required for matching. Other fields are displayed only when present. The included CSV contains headers only; it does not include fabricated provider ratings.

## 2. Install the extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select the `extension` folder from this package.
5. Open a news article and click the VITAL extension icon.
6. Choose **Scan this page**.

The API must be running while you use the extension.

## Tests

```bash
cd backend
pytest -q
```

## API contract

The extension uses the asynchronous job API:

- `POST /v1/analyse/jobs` starts an analysis.
- `GET /v1/analyse/jobs/{job_id}` reports real progress and returns the result.

The synchronous `POST /v1/analyse` endpoint remains available for Swagger and direct integration.

```json
{
  "url": "https://example.com/article",
  "title": "Article title",
  "text": "Visible article text...",
  "selected_text": null,
  "language": "en"
}
```

The response separates claim-detection confidence, checkworthiness, Factiverse verdict confidence and evidence-level scores. Health relevance has been removed.

## Current limitations

- The practical release supports English, matching the supplied notebook configuration.
- Highlighting supports claims split across inline elements within the same paragraph or heading. Claims reconstructed across separate paragraphs still appear in the side panel but may not highlight.
- Factiverse evidence response fields are normalised defensively because historical outputs show more than one response shape. Validate the mapper against several current live responses before a public pilot.
- Article extraction is generic. Publisher-specific adapters or a maintained readability library will improve noisy sites.
- This is a local research build. Public deployment needs authentication, rate limits, structured telemetry with consent, HTTPS, deletion rules and a security review.
- The localhost API has permissive development CORS. Before distributing the extension, restrict origins and add a short-lived client/session token so unrelated local webpages cannot invoke it.

## Why this structure

The extension handles only page interaction. The backend owns credentials, external calls, classification rules, caching and response normalisation. This makes the research pipeline replaceable without updating the browser extension and keeps sensitive configuration out of users’ browsers.
