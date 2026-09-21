"""Opt-in feedback. One record per installation, analysis and feature/claim."""

import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from .schemas import FeedbackRequest


def save_feedback(path: str, feedback: FeedbackRequest) -> dict:
    database = Path(path)
    database.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(database, timeout=15) as connection:
        connection.execute("""
            CREATE TABLE IF NOT EXISTS feedback (
                id INTEGER PRIMARY KEY,
                created_at TEXT NOT NULL,
                analysis_id TEXT NOT NULL,
                client_id TEXT NOT NULL,
                feature TEXT NOT NULL,
                claim_id TEXT NOT NULL DEFAULT '',
                rating TEXT NOT NULL,
                comment TEXT NOT NULL DEFAULT '',
                UNIQUE (analysis_id, client_id, feature, claim_id)
            )
        """)
        cursor = connection.execute(
            """INSERT OR IGNORE INTO feedback
               (created_at, analysis_id, client_id, feature, claim_id, rating, comment)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                datetime.now(timezone.utc).isoformat(),
                feedback.analysis_id,
                feedback.client_id,
                feedback.feature,
                feedback.claim_id,
                feedback.rating,
                feedback.comment,
            ),
        )
        inserted = cursor.rowcount == 1
        row = connection.execute(
            """SELECT id FROM feedback WHERE analysis_id=? AND client_id=?
               AND feature=? AND claim_id=?""",
            (
                feedback.analysis_id,
                feedback.client_id,
                feedback.feature,
                feedback.claim_id,
            ),
        ).fetchone()
    return {"saved": True, "feedback_id": row[0], "already_saved": not inserted}
