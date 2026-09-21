# VITAL · MediaFutures

Real Factiverse claim detection and evidence assessment, local article
classifiers, and a shared responsive interface. No simulated verdicts or evidence.

## What changed

- Claims start closed and can each be opened and closed independently.
- Clicking a highlighted passage opens its matching claim. Highlights have
  keyboard access and text labels as well as colour.
- Progress is shown while processing. Claims and all selected analysis sections
  are published together after processing finishes; there are no partial results.
- Settings contain only light and dark appearance modes. Every supported backend
  result is shown consistently.
- Optional feedback is saved once per feature/claim and analysis/installation.
- Desktop Chrome side panel and Safari resources for Mac, iPhone and iPad.
  A paste-text page is also available for local diagnostics.

The restrained panel layout takes inspiration from Raycast's compact utility UI:
https://www.raycast.com/
No marketing slogans or simulated “live” indicators are used.

## Run on your Mac

Extract into a NEW folder. Copy your existing backend .env into its backend
folder (do not share the key). If you do not have .env, copy .env.example and edit it.
Ensure it contains these settings:

```ini
FACTIVERSE_API_KEY=your-real-key
VITAL_DEMO_MODE=false
VITAL_ENABLE_ML=true
VITAL_ML_DEVICE=auto
```

From the project root:

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python -m pip install -r requirements-ml.txt
python -m pytest -q
python -m uvicorn app.main:app --host 127.0.0.1 --port 8765 --reload
```

Leave the terminal open. Health: http://127.0.0.1:8765/health
API explorer: http://127.0.0.1:8765/docs
Paste-text page: http://127.0.0.1:8765/app/sidepanel.html

First use may download the large topic model (~870MB) and sentiment model.
Classification across many health labels can still be slow on CPU. Models are
cached and reused while the backend remains running. Automatic device choice
uses CUDA if available, otherwise Apple MPS if available, otherwise CPU. If
your installed model/PyTorch combination fails on MPS, set VITAL_ML_DEVICE=cpu
and restart. A model failure is shown as unavailable, never replaced with fake data.

## Chrome on a computer

Open chrome://extensions, enable Developer mode and Load unpacked > extension.
Disable the older VITAL installation. Refresh the article tab after installing.
Open VITAL using the toolbar icon. Allow access to the page if asked.

## Safari on Mac, iPhone and iPad

extension-safari contains adapted Web Extension resources, not a signed app.
Toolbar access opens the same full-height panel design used by Chrome instead
of Safari's narrow popup. Backend jobs survive closing the panel and resume
when it is reopened. The panel fits narrow screens and supports touch controls.

Use full Xcode on your Mac to convert the resources:

```bash
xcrun safari-web-extension-converter ./extension-safari --app-name "VITAL"
```

Open the generated project in Xcode. Configure signing, build and run the macOS
app target, or the iOS app target for an iPhone/iPad simulator or device. Follow
the converter warnings. Enable VITAL in Safari's Extensions settings and grant
website access. Local unsigned Mac builds may require Allow Unsigned Extensions
in Safari's Develop menu. App Store/TestFlight distribution requires Apple's
signing and distribution process; it has NOT been done for this archive.

Apple guide:
https://developer.apple.com/videos/play/tech-talks/110148/

The native Safari build and actual iOS behaviour still need testing on Apple
devices. This package does not claim a tested or signed mobile Safari release.
Run python3 build_safari.py after changing shared extension files.

## Future hosting and Safari on phones

Mobile Chrome is outside this project's scope.

A phone cannot access the Mac backend through 127.0.0.1: that address means the
phone itself. You need a reachable backend URL, preferably HTTPS. The extension
manifest currently grants backend access to localhost only. When deploying,
add your exact HTTPS origin to `host_permissions` in the shared manifest and
change `apiBase` in `extension/sidepanel.js`, then rebuild the Safari resources.
Safari website permission may also be required.

Do NOT expose the development API publicly as-is. It has no authentication or
multi-user authorisation. A deployed service needs HTTPS, access controls,
request limits, restricted CORS, storage/retention policy and appropriate consent.
No remote deployment is performed by this archive.

## Models and data sources

- Claim detection: Factiverse /v1/claim_detection.
- Claim verification/evidence: Factiverse /v1/stance_detection.
- Health topics and advertorial labels: local zero-shot classification with
  MoritzLaurer/deberta-v3-large-zeroshot-v1. Advertorial detection is a zero-shot
  label choice, NOT a dedicated trained advertorial model.
- Headline/body sentiment: local
  distilbert/distilbert-base-uncased-finetuned-sst-2-english (English-only,
  positive/negative; not a neutral or multilingual sentiment model).
- Classifiers use a shortened excerpt, not every word of the article. Topic
  scores >= 0.20 are displayed, up to five. Scores indicate model confidence,
  not factual accuracy.
- Publisher metadata: backend/data/providers.csv, initially headers only.
  Supply a real licensed dataset to get records. No ratings are invented.
- Complete Factiverse responses remain available under Technical details.

Without a working key or with VITAL_DEMO_MODE=true, the existing local candidate
fallback may run. The UI explicitly says verification was not completed.
No random verdicts are assigned. Service errors appear in Analysis notes.

## Feedback

Users deliberately open Give feedback, choose Helpful/Not helpful, optionally
write a comment, and press Send. There are no popups or automatic submissions.
Stored fields: installation ID, analysis ID, feature, optional claim ID, rating,
comment and UTC timestamp. No name, email, IP address or article body is added
by the feedback writer. Normal server access logs still exist separately.

The backend writes data/feedback.sqlite3 (configurable via VITAL_FEEDBACK_DB).
The UNIQUE constraint enforces one entry per installation/analysis/feature/claim,
including repeated requests and concurrent submissions. It is not a global
“one person” identity: clearing browser data or switching browsers creates a new
installation. Feedback does not automatically retrain or correct the system.
SQLite persists across server restarts; analyse job/cache state does not.

No public feedback export endpoint is exposed. A backend administrator can
inspect the database locally:

```bash
sqlite3 data/feedback.sqlite3 "SELECT created_at, feature, claim_id, rating, comment FROM feedback ORDER BY id DESC;"
```

Feedback is accepted for analyses still known to this backend (job results up
to 12 hours or the cache). An old result restored after a restart may need a
fresh scan before feedback can be accepted. Keep feedback backups secure and
define retention/deletion rules before collecting study participant data.

## Disclaimers

Evidence assessments can be wrong. Inspect the sources and their context.
Insufficient evidence is not the same as false. Classifier outputs and publisher
metadata are contextual signals, not proofs. VITAL is not medical advice.
These notices are visible in the interface, not only in this README.

## Verification performed

14 backend tests passed (parsing, options, atomic results and feedback storage/API).
The UI DOM smoke test covers initialisation, collapsed claims, opening/closing,
atomic results, filtering, theme/settings persistence and opt-in feedback.
It uses clearly separated test fixtures, never production placeholder results.

To run the optional DOM check from the project root (Node.js required):

```bash
npm install
npm run test:ui
```

JavaScript/Python syntax checks passed. A rendered browser screenshot pass could
not be completed because the browser download timed out. Actual Chrome extension,
Safari and iPhone/iPad testing, real API access and model inference still need
checking in your environment. Automated tests stub the external API/model calls;
they do not certify Factiverse verdict accuracy or native browser support.
