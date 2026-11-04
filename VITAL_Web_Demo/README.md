# VITAL web demo 1.15.0

Open this folder in VS Code and run `python3 start_backend.py` for a local server. To update NREC, stage this folder separately, stop vital-demo, run `python3 update_existing.py /home/ubuntu/VITAL_Web_Demo`, and start vital-demo again. The updater preserves configuration, keys, data and venv. Health reports 1.15.0. The central analysis API is not modified.

New articles appear first. All widget changes are listed in the archive-level README. Original server statuses remain unchanged; the widget groups pending and skipped under Not Health Claim. Source and classifier details from saved server responses are remapped without reanalysing articles.

The sentiment display is Negative below -0.5, Slightly negative below -0.15, Neutral from -0.15 to +0.15, Slightly positive above +0.15, and Positive above +0.5. This is a UI description of sentiment, not a factual assessment. A missing or invalid signed score has no fabricated meter position.

Article includes all mapped metadata and an expandable All analysis details view. Commercial content has confidence/probabilities but no bar. Medical terms explain MeSH identifiers and tree codes. Navigation uses literal spelling/token variants and provided aliases, not arbitrary inferred medical synonyms.

See backend/tests and web/tests for the regression tests. The archive-level DOM tests exercise all three widgets. Native browser/device and live API testing are separate from these tests.

The public privacy notice is at /privacy. See ../PUBLICATION.md for publishing instructions and manual research-data handling.
