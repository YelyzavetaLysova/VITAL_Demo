import asyncio
import threading

import pytest
from fastapi.testclient import TestClient

from app import main
from app.schemas import AnalyseResponse, ArticleAnalysis, ClaimResult, AnalyseRequest


def result():
    return AnalyseResponse(
        analysis_id="test-analysis",
        mode="live",
        claims=[
            ClaimResult(
                id="test-claim",
                text="A test claim.",
                status="supported",
                status_label="Supported",
                explanation="Test fixture, not a real verification.",
            )
        ],
        pipeline={},
    )


def test_feedback_api_validates_and_deduplicates(tmp_path, monkeypatch):
    monkeypatch.setattr(
        main.settings, "vital_feedback_db", str(tmp_path / "feedback.sqlite3")
    )
    main.cache["test-entry"] = result()
    data = {
        "analysis_id": "test-analysis",
        "client_id": "test-installation-1234",
        "feature": "claim",
        "claim_id": "test-claim",
        "rating": "helpful",
    }
    with TestClient(main.app) as client:
        first = client.post("/v1/feedback", json=data)
        assert first.status_code == 200
        assert first.json()["saved"]
        assert client.post("/v1/feedback", json=data).json()["already_saved"]
        assert (
            client.post("/v1/feedback", json={**data, "claim_id": "wrong"}).status_code
            == 422
        )
        assert (
            client.post(
                "/v1/feedback", json={**data, "analysis_id": "missing"}
            ).status_code
            == 404
        )
        assert (
            client.post("/v1/feedback", json={**data, "feature": "system"}).status_code
            == 422
        )
        assert client.get("/app/sidepanel.html").status_code == 200
    main.cache.pop("test-entry", None)


@pytest.mark.asyncio
async def test_results_are_published_only_after_classifiers(monkeypatch):
    finish_classifier = threading.Event()

    async def fake_analyse(*args):
        return result().claims, [], "live"

    def slow_classifier(*args):
        finish_classifier.wait(timeout=3)
        return ArticleAnalysis()

    monkeypatch.setattr(main, "analyse", fake_analyse)
    monkeypatch.setattr(main, "analyse_article", slow_classifier)
    job = main.AnalysisJob(job_id="partial-test")
    request = AnalyseRequest(text="A fresh test article with enough text.")
    task = asyncio.create_task(main.run_job(job, request))
    try:
        for _ in range(30):
            if job.claims_finished:
                break
            await asyncio.sleep(0.01)
        assert job.claims_finished
        assert job.result is None
        assert not task.done()
    finally:
        finish_classifier.set()
        await task
    assert job.status == "completed"
    assert job.result.claims[0].id == "test-claim"
