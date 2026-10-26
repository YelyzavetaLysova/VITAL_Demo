import asyncio
import importlib
from io import BytesIO

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.demo_import import image_snapshot, parse_article, public_url
from app.demo_store import DemoStore


def article_data(**changes):
    return {
        "title": "A test article",
        "text": "A factual test claim appears in this article.\n\nA second paragraph is present.",
        "url": "https://example.com/article",
        "publisher": "Test publisher",
        "author": "Test author",
        "published_at": "2026-10-12T10:00:00Z",
        "image_url": "",
        "language": "en",
        "theme": "other",
        "visible": True,
        "rights_confirmed": True,
        **changes,
    }


@pytest.fixture
def demo(tmp_path, monkeypatch):
    monkeypatch.setenv("DEMO_ADMIN_PASSWORD", "test-organizer-password")
    monkeypatch.setenv("DEMO_DATABASE", str(tmp_path / "demo.sqlite3"))
    module = importlib.import_module("app.demo_main")
    monkeypatch.setattr(module, "store", DemoStore(tmp_path / "demo.sqlite3"))
    monkeypatch.setattr(module, "media", tmp_path)
    monkeypatch.setattr(module.config, "vital_api_key", "test-key")
    monkeypatch.setattr(
        module.config, "vital_feedback_db", str(tmp_path / "feedback.sqlite3")
    )
    monkeypatch.setattr(module.config, "vital_poll_interval_seconds", 0.01)
    module.config.demo_admin_password = "test-organizer-password"
    module.sessions.clear()
    module.login_attempts.clear()
    module.tasks.clear()
    return module


def test_import_metadata_and_plain_text():
    html = """<html lang="en"><head><meta property="og:image" content="/photo.jpg">
    <script type="application/ld+json">{"@type":"NewsArticle","headline":"Real headline",
    "author":{"name":"Reporter"},"datePublished":"2026-10-01","publisher":{"name":"Publication"}}</script></head>
    <body><nav><p>Navigation content should never be copied into the article snapshot.</p></nav>
    <article><p>A complete paragraph with enough words to be included in the snapshot.</p>
    <p>A second article paragraph with more detailed information.</p></article></body></html>"""
    result = parse_article(html, "https://example.com/story")
    assert result["title"] == "Real headline"
    assert result["author"] == "Reporter"
    assert result["published_at"] == "2026-10-01"
    assert result["image_url"] == "https://example.com/photo.jpg"
    assert "Navigation" not in result["text"]
    assert result["visible"] is False


@pytest.mark.asyncio
async def test_import_rejects_private_network(monkeypatch):
    monkeypatch.setattr(
        "socket.getaddrinfo", lambda *args: [(2, 1, 6, "", ("127.0.0.1", 80))]
    )
    with pytest.raises(ValueError, match="Private"):
        await public_url("http://localhost/private")


def test_uploaded_image_is_local_snapshot(tmp_path):
    body = BytesIO()
    Image.new("RGB", (50, 30), "white").save(body, "PNG")
    path = image_snapshot(body.getvalue(), tmp_path)
    assert path.startswith("/media/") and path.endswith(".jpg")
    assert (tmp_path / path.split("/")[-1]).exists()


def test_cache_survives_restart_and_invalidates_on_edit(tmp_path):
    store = DemoStore(tmp_path / "demo.sqlite3")
    record = store.save(article_data())
    store.change_analysis(
        record["id"],
        lambda _: {"phase": "completed", "claims": [], "completed_at": "test"},
    )
    store.prepared(record["id"])
    second = DemoStore(tmp_path / "demo.sqlite3")
    assert second.get(record["id"])["analysis"]["phase"] == "completed"
    assert second.get(record["id"])["prepared_at"]
    second.save(article_data(visible=False), record["id"])
    assert second.get(record["id"])["analysis"]
    second.save(
        article_data(text="Changed content invalidates every stored assessment."),
        record["id"],
    )
    assert second.get(record["id"])["analysis"] is None
    assert second.get(record["id"])["prepared_at"] is None


def test_interrupted_analysis_is_recoverable(tmp_path):
    store = DemoStore(tmp_path / "demo.sqlite3")
    record = store.save(article_data())
    store.change_analysis(
        record["id"],
        lambda _: {"phase": "checking", "claims": [{"status": "checking"}]},
    )
    second = DemoStore(tmp_path / "demo.sqlite3")
    result = second.get(record["id"])["analysis"]
    assert result["phase"] == "interrupted"
    assert result["claims"][0]["status"] == "pending"


def test_admin_auth_immediate_publication_and_csrf(demo):
    with TestClient(demo.app) as client:
        assert client.get("/api/admin/articles").status_code == 401
        assert (
            client.post("/api/admin/login", json={"password": "bad"}).status_code == 401
        )
        assert (
            client.post(
                "/api/admin/login", json={"password": "test-organizer-password"}
            ).status_code
            == 200
        )
        assert (
            client.post(
                "/api/admin/articles", json=article_data(rights_confirmed=False)
            ).status_code
            == 200
        )
        record = client.post("/api/admin/articles", json=article_data()).json()
        qr = client.post("/api/admin/qr", json={"url": "https://demo.example/"})
        assert qr.status_code == 200 and qr.content.startswith(b"\x89PNG")
        assert client.get("/api/demo/articles").json()[0]["id"] == record["id"]
        assert client.get(f"/api/demo/articles/{record['id']}").json()["text"]
        draft = client.post(
            "/api/admin/articles", json=article_data(visible=False)
        ).json()
        assert client.get(f"/api/demo/articles/{draft['id']}").status_code == 200
        assert draft["analysis"] is None
        assert (
            client.post(
                "/api/admin/articles",
                headers={"Origin": "https://evil.example"},
                json=article_data(),
            ).status_code
            == 403
        )
        assert (
            client.post(
                "/api/admin/image",
                files={"file": ("bad.svg", b"<svg/>", "image/svg+xml")},
            ).status_code
            == 422
        )


@pytest.mark.asyncio
async def test_remote_results_arrive_gradually_and_resume(demo, monkeypatch):
    import copy

    identifier = "eecf56c9-0516-46bb-b604-7a5104857003"
    claims = [
        {
            "id": "claim-1",
            "text": "A factual test claim appears in this article.",
            "status": "checking",
            "evidence": [],
        }
    ]
    observed = []

    class Service:
        async def submit(self, payload):
            observed.append(payload)
            return {"analysis_id": identifier, "status": "queued", "cache_hit": False}

        async def snapshot(self, remote_id):
            assert remote_id == identifier
            if len(observed) == 1:
                observed.append("snapshot")
                return {
                    "status": "running",
                    "result": {"claims": copy.deepcopy(claims)},
                }
            return {
                "status": "complete",
                "result": {
                    "claims": [
                        {
                            **claims[0],
                            "status": "supported",
                            "explanation": "Returned evidence supports this claim.",
                        }
                    ],
                    "article": {"topics": [{"label": "other", "score": 0.8}]},
                },
            }

    monkeypatch.setattr(demo, "vital_client", lambda: Service())
    record = demo.store.save(article_data())
    task = asyncio.create_task(demo.run_analysis(record["id"], prepared=True))
    await asyncio.sleep(0.005)
    intermediate = demo.store.get(record["id"])["analysis"]
    assert intermediate["claims"][0]["status"] == "checking"
    assert intermediate["phase"] != "completed"
    await task
    result = demo.store.get(record["id"])
    assert result["analysis"]["phase"] == "completed"
    assert result["analysis"]["claims"][0]["status"] == "supported"
    assert observed[0]["content"] == record["text"]
    assert observed[0]["provider"] == record["publisher"]
    assert result["prepared_at"]
    assert result["analysis"]["remote_analysis_id"] == identifier


@pytest.mark.asyncio
async def test_service_error_is_not_insufficient_evidence(demo, monkeypatch):
    from app.vital_api import VitalApiError

    record = demo.store.save(article_data())
    demo.store.change_analysis(
        record["id"],
        lambda _: {
            "analysis_id": "result-1",
            "phase": "completed",
            "claims": [
                {
                    "id": "claim-1",
                    "text": "A claim to verify.",
                    "status": "pending",
                    "evidence": [],
                }
            ],
        },
    )

    class Unavailable:
        async def submit(self, *args):
            raise VitalApiError("VITAL rejected this key.")

    monkeypatch.setattr(demo, "vital_client", lambda: Unavailable())
    await demo.verify_claim(record["id"], "claim-1")
    claim = demo.store.get(record["id"])["analysis"]["claims"][0]
    assert claim["status"] == "error"
    assert claim["status_label"] == "Check failed"


def test_manual_claim_inherits_organizer_category(demo):
    record = demo.store.save(article_data(theme="health"))
    demo.store.change_analysis(
        record["id"],
        lambda _: {"analysis_id": "analysis-1", "phase": "completed", "claims": []},
    )
    with TestClient(demo.app) as client:
        response = client.post(
            f"/api/demo/articles/{record['id']}/claims",
            json={
                "text": "A factual test claim appears in this article.",
                "theme": "politics",
            },
        )
    assert response.status_code == 200
    claim = demo.store.get(record["id"])["analysis"]["claims"][0]
    assert claim["theme"] == "health"


def test_feedback_is_saved_once_per_feature(demo):
    record = demo.store.save(article_data())
    demo.store.change_analysis(
        record["id"],
        lambda _: {
            "analysis_id": "analysis-1",
            "phase": "completed",
            "claims": [{"id": "claim-1", "status": "supported"}],
        },
    )
    payload = {
        "analysis_id": "analysis-1",
        "client_id": "a-client-identifier-123",
        "feature": "claim",
        "claim_id": "claim-1",
        "rating": "helpful",
        "comment": "Clear evidence.",
    }
    with TestClient(demo.app) as client:
        first = client.post(
            f"/api/demo/articles/{record['id']}/feedback", json=payload
        ).json()
        second = client.post(
            f"/api/demo/articles/{record['id']}/feedback", json=payload
        ).json()
    assert first["saved"] is True
    assert second["already_saved"] is True


def test_import_preserves_short_text_lazy_images_and_captions():
    html = """<html><head><meta property="og:title" content="Article"></head><body>
    <nav><p>Unwanted navigation words here.</p></nav><article>
    <p>Short intro.</p><figure><picture><source srcset="/small.jpg 400w, /large.jpg 1200w"><img alt="People"></picture><figcaption>Photo credit</figcaption></figure>
    <h2>Subheading</h2><p>A full second paragraph with some detailed news and factual statements.</p>
    <img data-src="/lazy.jpg" src="data:image/png;base64,x"></article></body></html>"""
    data = parse_article(html, "https://example.com/story")
    assert "Short intro." in data["text"]
    assert "Unwanted" not in data["text"]
    images = [block for block in data["blocks"] if block["type"] == "image"]
    assert [block["url"] for block in images] == [
        "https://example.com/large.jpg",
        "https://example.com/lazy.jpg",
    ]
    assert images[0]["caption"] == "Photo credit"
    assert data["blocks"][1]["type"] == "image"


def test_import_uses_nested_structured_body_when_html_has_no_text():
    import json

    body = "A complete factual news article has a long first paragraph describing what happened.\n\nThe second paragraph provides more details and information about the event."
    html = (
        '<html><script id="__NEXT_DATA__" type="application/json">'
        + json.dumps({"props": {"pageProps": {"news": {"articleBody": body}}}})
        + "</script><h1>A headline</h1><main></main></html>"
    )
    data = parse_article(html, "https://example.com/story")
    assert data["text"].startswith("A complete factual")
    assert data["import_method"] == "structured data"


@pytest.mark.asyncio
async def test_import_copies_inline_images_in_order(monkeypatch, tmp_path):
    from app.demo_import import import_article

    image = BytesIO()
    Image.new("RGB", (30, 20), "white").save(image, "PNG")
    html = b'<html><h1>Headline</h1><article><p>First paragraph with enough words for an article.</p><img src="/photo.png"><p>Second paragraph with enough words for an article.</p></article></html>'

    async def fake_download(url, max_bytes=0):
        return (
            (html, "text/html", url)
            if url.endswith("story")
            else (image.getvalue(), "image/png", url)
        )

    monkeypatch.setattr("app.demo_import.download", fake_download)
    result = await import_article("https://example.com/story", tmp_path)
    assert result["blocks"][1]["type"] == "image"
    assert result["blocks"][1]["url"].startswith("/media/")
    assert len(list(tmp_path.glob("*.jpg"))) == 1


def test_preparation_always_includes_every_result_and_does_not_duplicate(
    demo, monkeypatch
):
    observed = []
    monkeypatch.setattr(
        demo, "start_analysis", lambda identifier, **kw: observed.append(kw)
    )
    with TestClient(demo.app) as client:
        client.post("/api/admin/login", json={"password": "test-organizer-password"})
        article = client.post("/api/admin/articles", json=article_data()).json()
        response = client.post(f"/api/admin/articles/{article['id']}/prepare")
        assert response.status_code == 200
        assert observed == [{"prepared": True}]
        demo.tasks[article["id"]] = object()
        response = client.post(f"/api/admin/articles/{article['id']}/prepare")
        assert response.json()["already_running"] is True
        assert len(observed) == 1
        demo.tasks.clear()


def test_catalogue_exposes_queue_state_without_raw_response(demo):
    record = demo.store.save(article_data())
    demo.store.change_analysis(
        record["id"],
        lambda _: {
            "phase": "detecting",
            "remote_status": "queued",
            "message": "Queued for analysis.",
            "server_response": {"private": "not public"},
        },
    )
    with TestClient(demo.app) as client:
        item = client.get("/api/demo/articles").json()[0]
        assert item["analysis_status"] == "queued"
        assert "analysis" not in item


def test_widget_articles_are_private_and_reused(demo):
    with TestClient(demo.app) as client:
        first = client.post("/api/widget/articles", json=article_data()).json()
        second = client.post("/api/widget/articles", json=article_data()).json()
        assert first["id"] == second["id"]
        assert client.get("/api/demo/articles").json() == []
        origin = "chrome-extension://abcdef"
        response = client.post(
            "/api/widget/articles", json=article_data(), headers={"Origin": origin}
        )
        assert response.headers["access-control-allow-origin"] == origin


def test_visitor_articles_prepend_to_shared_catalogue_and_start_analysis(
    demo, monkeypatch
):
    async def fake_import(url, directory):
        return article_data(
            title="Visitor article",
            text="A factual paragraph describing the event and providing additional details for readers. "
            * 3,
            url=url,
            warnings=[],
        )

    started = []
    monkeypatch.setattr(demo, "import_article", fake_import)
    monkeypatch.setattr(
        demo, "start_analysis", lambda identifier: started.append(identifier)
    )
    original = demo.store.save(article_data())
    with TestClient(demo.app) as client:
        result = client.post(
            "/api/demo/import", json={"url": "https://example.com/new"}
        )
        assert result.status_code == 200
        cards = client.get("/api/demo/articles").json()
        assert [item["id"] for item in cards] == [result.json()["id"], original["id"]]
        assert started == [result.json()["id"]]


def test_feedback_export_preserves_evaluated_output(demo):
    record = demo.store.save(article_data())
    demo.store.change_analysis(
        record["id"],
        lambda _: {
            "analysis_id": "snapshot-1",
            "phase": "completed",
            "claims": [{"id": "claim-1", "text": "A claim", "status": "supported"}],
            "article": {"category": "health"},
        },
    )
    with TestClient(demo.app) as client:
        body = {
            "analysis_id": "snapshot-1",
            "client_id": "installation-123456",
            "feature": "claim",
            "claim_id": "claim-1",
            "rating": "incorrect",
            "comment": "Evidence does not support it.",
        }
        assert (
            client.post(
                f"/api/demo/articles/{record['id']}/feedback", json=body
            ).status_code
            == 200
        )
        assert client.get("/api/admin/feedback").status_code == 401
        client.post("/api/admin/login", json={"password": "test-organizer-password"})
        result = client.get("/api/admin/feedback").json()
        assert result[0]["rating"] == "incorrect"
        assert result[0]["context"]["claim"]["status"] == "supported"
        assert result[0]["context"]["article_id"] == record["id"]


@pytest.mark.asyncio
async def test_progress_events_arrive_before_final_snapshot(demo, monkeypatch):
    from app.vital_api import VitalApiError

    identifier = "d04aa3c8-6aaf-4dd4-ac97-96eae005114e"
    event_ready = asyncio.Event()
    finish = asyncio.Event()

    class EventClient:
        async def submit(self, payload):
            return {"analysis_id": identifier, "status": "queued"}

        async def snapshot(self, remote_id):
            if finish.is_set():
                return {
                    "status": "complete",
                    "claim_result": {
                        "detectedClaims": [
                            {"text": "A factual test claim appears in this article."}
                        ],
                        "stanceResults": [
                            {
                                "candidateIndex": 0,
                                "claim": "A factual test claim appears in this article.",
                                "result": {"label": "SUPPORTS"},
                            }
                        ],
                    },
                }
            return {"status": "running", "claim_result": None}

        async def events(self, remote_id, after="0-0"):
            yield "1-0", {
                "event_type": "stance.completed",
                "payload": {
                    "candidateIndex": 0,
                    "claim": "A factual test claim appears in this article.",
                    "result": {"label": "SUPPORTS"},
                },
            }
            event_ready.set()
            await finish.wait()
            yield "2-0", {"event_type": "analysis.complete", "payload": {}}

    monkeypatch.setattr(demo, "vital_client", lambda: EventClient())
    record = demo.store.save(article_data())
    task = asyncio.create_task(demo.run_analysis(record["id"]))
    await asyncio.wait_for(event_ready.wait(), 1)
    saved = demo.store.get(record["id"])["analysis"]
    assert saved["phase"] != "completed"
    assert saved["claims"][0]["status"] == "supported"
    finish.set()
    await asyncio.wait_for(task, 2)
    assert demo.store.get(record["id"])["analysis"]["phase"] == "completed"


@pytest.mark.asyncio
async def test_timeout_is_resumable_and_keeps_remote_id(demo, monkeypatch):
    from app.vital_api import VitalApiError

    remote = "d04aa3c8-6aaf-4dd4-ac97-96eae005114e"

    class Waiting:
        async def submit(self, payload):
            return {"analysis_id": remote, "status": "queued"}

        async def snapshot(self, identifier):
            return {"status": "queued"}

    monkeypatch.setattr(demo, "vital_client", lambda: Waiting())
    monkeypatch.setattr(demo.config, "vital_result_timeout_seconds", 0)
    record = demo.store.save(article_data())
    await demo.run_analysis(record["id"])
    result = demo.store.get(record["id"])["analysis"]
    assert result["phase"] == "interrupted"
    assert result["remote_analysis_id"] == remote
    assert result["error_code"] == "waiting"
    assert "not be submitted again" in result["message"]


def test_safe_api_error_is_visible_to_widget(demo):
    record = demo.store.save(article_data())
    demo.store.change_analysis(
        record["id"],
        lambda _: {
            "analysis_id": "id",
            "phase": "failed",
            "claims": [],
            "message": "VITAL's rate or analysis quota has been reached. Try again later. (HTTP 429)",
            "error_code": "quota",
        },
    )
    with TestClient(demo.app) as client:
        result = client.get(f"/api/demo/articles/{record['id']}").json()["analysis"]
        assert "429" in result["message"]
        assert result["error_code"] == "quota"


def test_manual_claims_above_thirty_reuse_results(demo):
    text = "A factual test claim appears in this article."
    record = demo.store.save(article_data())
    claims = [{"id": f"old-{i}", "text": f"Existing claim {i}.", "status": "supported"}
              for i in range(35)]
    claims.append({"id": "analyzed", "text": text, "status": "supported", "evidence": [{"url": "https://example.com/source"}]})
    demo.store.change_analysis(record["id"], lambda _: {"analysis_id": "test", "phase": "completed", "claims": claims})
    with TestClient(demo.app) as client:
        duplicate = client.post(f"/api/demo/articles/{record['id']}/claims", json={"text": text.replace(" ", "  ")})
        assert duplicate.status_code == 200
        assert duplicate.json()["claim_id"] == "analyzed"
        added = client.post(f"/api/demo/articles/{record['id']}/claims", json={"text": "A second paragraph is present."})
        assert added.status_code == 200
    saved = demo.store.get(record["id"])["analysis"]["claims"]
    assert len(saved) == 37
    assert saved[-1]["status"] == "pending"
    assert saved[-2]["evidence"] == claims[-1]["evidence"]


def test_cached_provider_is_exposed_without_reanalysis(demo):
    record = article_data()
    record["analysis"] = {"analysis_id": "cached", "phase": "completed", "claims": [],
        "article": {}, "server_response": {"claim_result": {}, "provider": {"source_name": "BBC News", "credibility": "High"}}}
    result = demo.public_article(record)
    assert result["analysis"]["article"]["provider"]["source_name"] == "BBC News"
    assert "server_response" not in result["analysis"]


@pytest.mark.asyncio
async def test_completed_claim_is_not_verified_again(demo, monkeypatch):
    record = demo.store.save(article_data())
    demo.store.change_analysis(record["id"], lambda _: {
        "analysis_id": "test", "phase": "completed", "claims": [
            {"id": "done", "text": "A factual test claim appears in this article.", "status": "supported"}]})
    def unexpected_client():
        raise AssertionError("Do not resubmit an already analyzed claim")
    monkeypatch.setattr(demo, "vital_client", unexpected_client)
    await demo.verify_claim(record["id"], "done")
    assert demo.store.get(record["id"])["analysis"]["claims"][0]["status"] == "supported"


def test_editing_an_article_does_not_move_it_above_newer_articles(demo):
    old = demo.store.save(article_data(title="Old article"))
    new = demo.store.save(article_data(title="New article", url="https://example.com/newest"))
    demo.store.save(article_data(title="Old article edited"), identifier=old["id"])
    assert [item["id"] for item in demo.store.list(public=True)] == [new["id"], old["id"]]


def test_cached_commercial_details_are_remapped_without_analysis(demo):
    record = article_data()
    record["analysis"] = {"analysis_id": "cached", "phase": "completed", "claims": [],
        "article": {"advertorial": {"label": "non-advertorial", "score": .9}},
        "server_response": {"claim_result": {}, "advertorial_result": {"label": "non-advertorial", "confidence": .9, "input_tokens": 20}}}
    result = demo.public_article(record)
    assert result["analysis"]["article"]["advertorial"]["input_tokens"] == 20
