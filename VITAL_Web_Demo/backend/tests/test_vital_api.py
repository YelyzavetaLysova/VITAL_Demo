import json

import httpx
import pytest

from app.vital_api import (
    VitalApiError,
    VitalClient,
    normalise_result,
    submission_payload,
)


def test_submission_matches_documented_contract():
    record = {
        "id": "article-1",
        "title": "Headline",
        "text": "Article body",
        "url": "https://example.com/story",
        "published_at": "2026-10-12T10:00:00Z",
        "publisher": "Example",
        "theme": "health",
        "language": "en",
        "image_url": "/media/abc.jpg",
        "original_image_url": "https://example.com/photo.jpg",
    }
    result = submission_payload(record)
    assert result["content"] == record["text"]
    assert result["provider"] == "Example"
    assert result["category"] == "health"
    assert result["country"] == "NO"
    assert result["image_url"] == "https://example.com/photo.jpg"
    assert result["published_at"].startswith("2026-10-12T10:00")
    record["published_at"] = "2026-10-12"
    assert "published_at" not in submission_payload(
        record
    ), "Do not invent a publication time"
    assert (
        submission_payload(record, selected_text="Selected claim", category="politics")[
            "content"
        ]
        == "Selected claim"
    )


@pytest.mark.asyncio
async def test_bearer_header_version_and_polling():
    observed = []
    identifier = "d04aa3c8-6aaf-4dd4-ac97-96eae005114e"

    def handle(request):
        observed.append(request)
        assert request.headers["Authorization"] == "Bearer test-key"
        assert request.headers["X-Vital-Client-Version"] == "frontend-1.0"
        if request.method == "POST":
            assert json.loads(request.content)["content"] == "Test article body"
            return httpx.Response(
                202,
                json={
                    "analysis_id": identifier,
                    "status": "queued",
                    "events_url": f"/v1/analyses/{identifier}/events",
                },
            )
        return httpx.Response(
            200,
            json={
                "analysis_id": identifier,
                "status": "complete",
                "result": {"claims": []},
            },
        )

    client = VitalClient(
        "https://api.vital.mediafutures.no",
        "test-key",
        transport=httpx.MockTransport(handle),
    )
    accepted = await client.submit(
        {"title": "Test", "content": "Test article body", "url": "https://example.com"}
    )
    result = await client.snapshot(accepted["analysis_id"])
    assert result["status"] == "complete"
    assert observed[1].url.path == f"/v1/analyses/{identifier}"


@pytest.mark.asyncio
async def test_auth_error_is_actionable_without_exposing_key():
    client = VitalClient(
        "https://api.vital.mediafutures.no",
        "secret-not-for-display",
        transport=httpx.MockTransport(lambda request: httpx.Response(401)),
    )
    with pytest.raises(VitalApiError) as error:
        await client.submit({})
    assert "401" in str(error.value)
    assert "secret-not-for-display" not in str(error.value)


def test_unknown_result_is_reported_not_fabricated():
    claims, article, warnings = normalise_result(
        {"status": "complete", "result": {"future_server_format": [1, 2]}}
    )
    assert claims == [] and article == {}
    assert warnings


def test_passage_url_must_be_configured():
    with pytest.raises(VitalApiError, match="URL"):
        submission_payload({"title": "Manual", "text": "Article", "url": ""})


def test_actual_vital_partial_response():
    from pathlib import Path

    snapshot = json.loads(
        (Path(__file__).parent / "fixtures/vital-health-live-snapshot.json").read_text()
    )
    claims, article, warnings = normalise_result(snapshot)
    assert claims and claims[0]["status"] == "error"
    assert article["category"] == "health"
    assert article["claim_classification"]
    assert article["unavailable"]
    assert claims[0]["evidence"] == []


def test_rejected_candidates_are_not_verdicts():
    snapshot = {
        "status": "complete",
        "claim_result": {
            "detectedClaims": [{"text": "A claim outside the selected topic."}],
            "classification": {
                "claims": [
                    {
                        "candidate_index": 0,
                        "accepted": False,
                        "category": "Unrelated",
                        "reason": "Outside topic.",
                    }
                ]
            },
        },
    }
    claims, article, warnings = normalise_result(snapshot)
    assert claims[0]["status"] == "skipped"
    assert claims[0]["scope_reason"] == "Outside topic."


def test_running_detection_can_be_displayed_before_verdicts():
    claims, _, _ = normalise_result(
        {
            "status": "running",
            "claim_result": {
                "detectedClaims": [{"text": "Detected wording."}],
                "classification": {
                    "claims": [{"candidate_index": 0, "accepted": True}]
                },
            },
        }
    )
    assert claims[0]["status"] == "checking"


def test_coordinator_numeric_sentiment_zero_topics_and_entities():
    snapshot = {
        "status": "complete",
        "claim_result": {
            "detectedClaims": [],
            "classification": {
                "article_category": "health",
                "main_topic": "Diet and nutrition",
                "descriptive_topic": "Coffee",
                "claims": [],
            },
        },
        "transformation_result": {
            "title_sentiment": 0.0,
            "content_sentiment": -0.42,
            "word_count": 120,
            "entities_persons": {"A Researcher": {"count": 2, "confidence": 0.9}},
            "entities_medical": {"Heart disease": {"count": 1, "mesh_id": "D006331"}},
            "summary_generated": None,
        },
    }
    _, article, _ = normalise_result(snapshot)
    assert article["title_sentiment"] == {"score": 0.0, "scale": "minus_one_to_one"}
    assert article["content_sentiment"]["score"] == -0.42
    assert article["main_topic"] == "Diet and nutrition"
    assert article["word_count"] == 120
    assert article["entities_persons"]["A Researcher"]["count"] == 2
    assert article["entities_medical"]["Heart disease"]["mesh_id"] == "D006331"
    assert article.get("summary_generated") is None


@pytest.mark.parametrize(
    "field,value,expected",
    [
        ("label", "SUPPORTS", "supported"),
        ("finalLabel", "REFUTES", "contradicted"),
        ("final_prediction_label", "NEI", "insufficient"),
    ],
)
def test_coordinator_stance_label_variants(field, value, expected):
    snapshot = {
        "status": "complete",
        "claim_result": {
            "detectedClaims": [{"text": "This is an example claim."}],
            "stanceResults": [
                {
                    "candidateIndex": 0,
                    "claim": "This is an example claim.",
                    "result": {field: value},
                }
            ],
        },
    }
    claims, _, _ = normalise_result(snapshot)
    assert claims[0]["status"] == expected


def test_numeric_verdicts_without_a_label_map_are_not_guessed():
    from app.vital_api import verdict_status

    assert verdict_status(2) == "pending"
    assert verdict_status(2, {"2": "NOT_ENOUGH_INFO"}) == "insufficient"


@pytest.mark.asyncio
async def test_authenticated_sse_parser_uses_server_after_cursor():
    identifier = "d04aa3c8-6aaf-4dd4-ac97-96eae005114e"
    event = {
        "event_type": "stance.completed",
        "payload": {
            "candidateIndex": 0,
            "claim": "A claim",
            "result": {"label": "SUPPORTS"},
        },
    }

    def handle(request):
        assert request.headers["Authorization"] == "Bearer test-key"
        assert request.url.params["after"] == "123-0"
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content=f"id: 124-0\nevent: stance.completed\ndata: {json.dumps(event)}\n\n".encode(),
        )

    client = VitalClient(
        "https://api.vital.mediafutures.no",
        "test-key",
        transport=httpx.MockTransport(handle),
    )
    events = [item async for item in client.events(identifier, after="123-0")]
    assert events == [("124-0", event)]


def test_event_projection_keeps_real_claim_wording_ids_and_index():
    from app.progress import CoordinatorProgress

    progress = CoordinatorProgress()
    partial = progress.consume(
        {
            "event_type": "claims.chunk.completed",
            "payload": {"chunkIndex": 0, "claimCount": 3},
        }
    )
    assert partial["detected_count"] == 3 and partial["claims"] == []
    result = {
        "candidateIndex": 2,
        "claim": "The third actual claim.",
        "result": {"label": "SUPPORTS"},
    }
    partial = progress.consume({"event_type": "stance.completed", "payload": result})
    assert len(partial["claims"]) == 1
    claim = partial["claims"][0]
    assert claim["candidate_index"] == 2 and claim["status"] == "supported"
    final, _, _ = normalise_result(
        {
            "status": "complete",
            "claim_result": {
                "detectedClaims": [
                    {"text": "First"},
                    {"text": "Second"},
                    {"text": "The third actual claim.", "raw": {"_id": "upstream-id"}},
                ],
                "stanceResults": [result],
            },
        }
    )
    assert final[2]["id"] == claim["id"]
    partial = progress.consume(
        {
            "event_type": "transformation.completed",
            "payload": {
                "wordCount": 7,
                "titleSentiment": 0.0,
                "contentSentiment": -0.4,
            },
        }
    )
    assert partial["article"]["title_sentiment"]["score"] == 0.0


def test_claim_reasons_are_preserved_and_missing_reasons_are_explicit():
    from app.vital_api import normalise_vital_snapshot

    data = {
        "status": "complete",
        "claim_result": {
            "detectedClaims": [
                {"text": "First claim."},
                {"text": "Second claim."},
                {"text": "Third claim."},
            ],
            "classification": {
                "claims": [
                    {
                        "candidate_index": 1,
                        "accepted": False,
                        "reason": "Personal account; not independently checkable.",
                    }
                ]
            },
            "stanceResults": [
                {
                    "candidateIndex": 2,
                    "errorType": "ExternalCallFailed",
                    "reason": "Service unavailable",
                }
            ],
        },
    }
    claims, _, _ = normalise_vital_snapshot(data)
    assert claims[0]["status"] == "pending"
    assert claims[0]["explanation"] == "No verification result or reason was provided."
    assert claims[1]["status"] == "skipped"
    assert claims[1]["explanation"] == "Personal account; not independently checkable."
    assert claims[2]["status"] == "error"
    assert claims[2]["explanation"] == "Service unavailable"
    assert claims[2]["api_error_type"] == "ExternalCallFailed"


@pytest.mark.parametrize("snapshot", [
    {"claim_result": {}, "status": "partial"},
    {"claims": [], "status": "complete"},
])
def test_provider_metadata_is_preserved(snapshot):
    provider = {
        "source_url": "https://bbc.com", "source_name": "BBC News",
        "bias": "Least Biased", "country": "United Kingdom",
        "factual_reporting": "Mostly Factual", "media_type": "TV Station",
        "mbfc_url": "https://mediabiasfactcheck.com/bbc/",
        "credibility": "High", "source_id": 102755, "dataset": "mbfc",
    }
    snapshot["provider"] = provider
    _, article, _ = normalise_result(snapshot)
    assert article["provider"] == provider


def test_detailed_commercial_and_classification_metadata_is_retained():
    _, article, _ = normalise_result({
        "status": "complete", "claim_result": {"classification": {"health_related": True, "topic_reason": "A topic reason"}},
        "advertorial_result": {"label": "non-advertorial", "confidence": .95, "prob_advertorial": .05, "prob_non_advertorial": .95, "input_tokens": 100},
    })
    assert article["advertorial"]["prob_advertorial"] == .05
    assert article["advertorial"]["input_tokens"] == 100
    assert article["classification"]["health_related"] is True
