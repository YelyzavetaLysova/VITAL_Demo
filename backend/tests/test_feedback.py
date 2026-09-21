import sqlite3
from concurrent.futures import ThreadPoolExecutor

from app.feedback import save_feedback
from app.schemas import FeedbackRequest


def payload(**changes):
    values = {
        "analysis_id": "analysis-one",
        "client_id": "anonymous-client-123456",
        "feature": "claim",
        "claim_id": "claim-one",
        "rating": "helpful",
        "comment": " Clear sources. ",
    }
    values.update(changes)
    return FeedbackRequest(**values)


def test_feedback_deduplicates_and_survives_reopen(tmp_path):
    path = str(tmp_path / "feedback.sqlite3")
    first = save_feedback(path, payload())
    second = save_feedback(path, payload(rating="not_helpful"))
    assert first["saved"] and not first["already_saved"]
    assert second["already_saved"]
    assert first["feedback_id"] == second["feedback_id"]
    with sqlite3.connect(path) as connection:
        assert connection.execute(
            "SELECT rating, comment FROM feedback"
        ).fetchall() == [("helpful", "Clear sources.")]


def test_features_claims_analyses_are_independent(tmp_path):
    path = str(tmp_path / "feedback.sqlite3")
    save_feedback(path, payload())
    save_feedback(path, payload(claim_id="claim-two"))
    save_feedback(path, payload(feature="topics", claim_id=""))
    save_feedback(path, payload(analysis_id="analysis-two"))
    with sqlite3.connect(path) as connection:
        assert connection.execute("SELECT COUNT(*) FROM feedback").fetchone()[0] == 4


def test_concurrent_feedback_is_saved_once(tmp_path):
    path = str(tmp_path / "feedback.sqlite3")
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: save_feedback(path, payload()), range(8)))
    assert sum(not result["already_saved"] for result in results) == 1
