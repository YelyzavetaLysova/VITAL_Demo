"""Durable article snapshots and analysis results for the web demonstration."""

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4


def now():
    return datetime.now(timezone.utc).isoformat()


class DemoStore:
    def __init__(self, filename):
        self.filename = Path(filename)
        self.filename.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS articles (
                id TEXT PRIMARY KEY, content TEXT NOT NULL, analysis TEXT,
                prepared_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            )""")
            # A interrupted server process must not leave an endless spinner.
            for row in db.execute(
                "SELECT id, analysis FROM articles WHERE analysis IS NOT NULL"
            ):
                analysis = json.loads(row[1])
                if analysis.get("phase") in {"detecting", "checking", "classifying"}:
                    analysis["phase"] = "interrupted"
                    analysis["message"] = (
                        "The server restarted. Resume the remaining checks."
                    )
                    for claim in analysis.get("claims", []):
                        if claim["status"] == "checking":
                            claim.update(status="pending", status_label="Not checked")
                    db.execute(
                        "UPDATE articles SET analysis=? WHERE id=?",
                        (json.dumps(analysis), row[0]),
                    )

    def connect(self):
        db = sqlite3.connect(self.filename, timeout=10)
        db.row_factory = sqlite3.Row
        return db

    def get(self, identifier):
        with self.connect() as db:
            row = db.execute(
                "SELECT * FROM articles WHERE id=?", (identifier,)
            ).fetchone()
        if not row:
            return None
        return {
            **json.loads(row["content"]),
            "id": row["id"],
            "analysis": json.loads(row["analysis"]) if row["analysis"] else None,
            "prepared_at": row["prepared_at"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def list(self, public=False):
        with self.connect() as db:
            identifiers = [
                row[0]
                for row in db.execute(
                    "SELECT id FROM articles ORDER BY created_at DESC, rowid DESC"
                )
            ]
        items = [self.get(identifier) for identifier in identifiers]
        return (
            [item for item in items if item and not item.get("widget_only")]
            if public
            else items
        )

    def save(self, data, identifier=None):
        identifier = identifier or uuid4().hex
        previous = self.get(identifier)
        # Any content or attribution edit invalidates the corresponding snapshot.
        old_content = None
        if previous:
            old_content = {key: previous.get(key) for key in data}
        substantive = [
            key for key in data if key not in {"visible", "rights_confirmed"}
        ]
        changed = not previous or any(
            old_content.get(key) != data[key] for key in substantive
        )
        with self.connect() as db:
            if previous:
                db.execute(
                    "UPDATE articles SET content=?, updated_at=?, analysis=?, prepared_at=? WHERE id=?",
                    (
                        json.dumps(data),
                        now(),
                        (
                            None
                            if changed
                            else (
                                json.dumps(previous["analysis"])
                                if previous["analysis"]
                                else None
                            )
                        ),
                        None if changed else previous["prepared_at"],
                        identifier,
                    ),
                )
            else:
                db.execute(
                    "INSERT INTO articles VALUES (?, ?, NULL, NULL, ?, ?)",
                    (identifier, json.dumps(data), now(), now()),
                )
        return self.get(identifier)

    def change_analysis(self, identifier, update):
        with self.connect() as db:
            row = db.execute(
                "SELECT analysis FROM articles WHERE id=?", (identifier,)
            ).fetchone()
            if not row:
                return
            current = json.loads(row[0]) if row[0] else None
            result = update(current)
            db.execute(
                "UPDATE articles SET analysis=?, updated_at=? WHERE id=?",
                (json.dumps(result), now(), identifier),
            )

    def prepared(self, identifier):
        with self.connect() as db:
            db.execute(
                "UPDATE articles SET prepared_at=? WHERE id=?", (now(), identifier)
            )

    def reset_analysis(self, identifier):
        with self.connect() as db:
            db.execute(
                "UPDATE articles SET analysis=NULL, prepared_at=NULL WHERE id=?",
                (identifier,),
            )

    def delete(self, identifier):
        with self.connect() as db:
            db.execute("DELETE FROM articles WHERE id=?", (identifier,))
