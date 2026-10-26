"""Standalone, same-origin VITAL web demonstration with a protected organizer area."""

import asyncio
import hmac
import re
import secrets
import time
import json
import sqlite3
from io import BytesIO
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlparse
from uuid import uuid4

from fastapi import Depends, FastAPI, File, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
import qrcode

from .demo_import import image_snapshot, import_article
from .demo_store import DemoStore, now
from .feedback import save_feedback
from .progress import CoordinatorProgress
from .schemas import FeedbackRequest
from .vital_api import (
    VitalClient,
    VitalApiError,
    normalise_result,
    result_status,
    submission_payload,
)


class DemoConfig(BaseSettings):
    demo_admin_password: str
    demo_extensions_enabled: bool = False
    demo_database: str = "data/demo.sqlite3"
    demo_secure_cookies: bool = False
    demo_public_url: str = ""
    vital_api_key: str = ""
    vital_api_base: str = "https://api.vital.mediafutures.no"
    vital_client_version: str = "frontend-1.0"
    vital_feedback_db: str = "data/feedback.sqlite3"
    vital_result_timeout_seconds: int = 900
    vital_poll_interval_seconds: float = 2
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


config = DemoConfig()
store = DemoStore(config.demo_database)
web = Path(__file__).resolve().parents[2] / "web"
media = Path(config.demo_database).resolve().parent / "media"
media.mkdir(parents=True, exist_ok=True)
sessions = {}
login_attempts = {}
tasks = {}
remote_slots = asyncio.Semaphore(2)
article_slots = asyncio.Semaphore(2)


@asynccontextmanager
async def lifespan(app):
    yield
    for task in list(tasks.values()):
        task.cancel()
    if tasks:
        await asyncio.gather(*list(tasks.values()), return_exceptions=True)


app = FastAPI(
    title="VITAL web demo",
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^(chrome-extension|moz-extension|safari-web-extension)://[A-Za-z0-9-]+$",
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)
app.mount("/assets", StaticFiles(directory=web / "assets"), name="assets")
app.mount("/media", StaticFiles(directory=media), name="media")


@app.middleware("http")
async def browser_headers(request, call_next):
    demo_prefix = "/demo-api/v1"
    path = request.scope["path"]
    if path == demo_prefix or path.startswith(demo_prefix + "/"):
        suffix = path[len(demo_prefix):]
        allowed = (
            suffix == "/health" and request.method == "GET"
            or suffix == "/api/demo/import" and request.method == "POST"
            or suffix == "/api/demo/articles" and request.method == "GET"
            or re.fullmatch(r"/api/demo/articles/[^/]+", suffix) and request.method == "GET"
            or re.fullmatch(r"/api/demo/articles/[^/]+/(analyse|claims|feedback)", suffix) and request.method == "POST"
            or re.fullmatch(r"/api/demo/articles/[^/]+/claims/[^/]+/check", suffix) and request.method == "POST"
        )
        if request.method != "OPTIONS" and not config.demo_extensions_enabled:
            return JSONResponse({"detail": "This demo has ended.", "code": "demo_ended"}, status_code=410, headers={"Cache-Control": "no-store"})
        if not allowed and request.method != "OPTIONS":
            return JSONResponse({"detail": "Not found"}, status_code=404)
        request.scope["path"] = suffix
        request.scope["raw_path"] = suffix.encode()
    if request.method in {"POST", "PUT", "DELETE"}:
        origin = request.headers.get("origin")
        if (
            origin
            and urlparse(origin).netloc != request.headers.get("host")
            and urlparse(origin).scheme
            not in {"chrome-extension", "safari-web-extension", "moz-extension"}
        ):
            return Response("Cross-site requests are not accepted.", status_code=403)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self'; style-src 'self'; "
        "img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; "
        "base-uri 'self'; form-action 'self'"
    )
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


def organizer(request: Request):
    token = request.cookies.get("vital_organizer", "")
    if sessions.get(token, 0) < time.monotonic():
        sessions.pop(token, None)
        raise HTTPException(401, "Sign in to the organizer page.")


class Login(BaseModel):
    password: str = Field(max_length=200)


class URLInput(BaseModel):
    url: str = Field(max_length=3000)


class ArticleBlock(BaseModel):
    type: str = Field(pattern=r"^(paragraph|heading|image)$")
    text: str = Field(default="", max_length=120000)
    url: str = Field(default="", max_length=100)
    alt: str = Field(default="", max_length=1000)
    caption: str = Field(default="", max_length=2000)

    @field_validator("url")
    @classmethod
    def image_path(cls, value):
        if value and not re.fullmatch(r"/media/[a-f0-9]{32}\.jpg", value):
            raise ValueError("Import the image first.")
        return value


class PrepareInput(BaseModel):
    features: list[str] = Field(
        default_factory=lambda: [
            "claims",
            "classification",
            "advertorial",
            "sentiment",
            "provider",
            "transformation",
        ],
        min_length=1,
    )

    @field_validator("features")
    @classmethod
    def supported_features(cls, values):
        if not set(values) <= {
            "claims",
            "classification",
            "advertorial",
            "sentiment",
            "provider",
            "transformation",
        }:
            raise ValueError("Unknown preparation feature.")
        return list(dict.fromkeys(values))


class ArticleInput(BaseModel):
    title: str = Field(min_length=1, max_length=1000)
    text: str = Field(min_length=12, max_length=120000)
    url: str = Field(default="", max_length=3000)
    publisher: str = Field(default="", max_length=200)
    country: str = Field(default="NO", min_length=2, max_length=5)
    original_image_url: str = Field(default="", max_length=2083)
    author: str = Field(default="", max_length=500)
    published_at: str = Field(default="", max_length=100)
    image_url: str = Field(default="", max_length=100)
    language: str = "en"
    theme: str = "other"
    blocks: list[ArticleBlock] = Field(default_factory=list, max_length=3000)

    @model_validator(mode="after")
    def consistent_text(self):
        if self.blocks:
            block_text = " ".join(
                block.text for block in self.blocks if block.type != "image"
            )
            if " ".join(block_text.split()) != " ".join(self.text.split()):
                raise ValueError("The article blocks must match its text.")
        return self

    @field_validator("url")
    @classmethod
    def safe_link(cls, value):
        if value and (
            urlparse(value).scheme not in {"http", "https"}
            or not urlparse(value).hostname
        ):
            raise ValueError("Use an http or https source URL.")
        return value

    @field_validator("image_url")
    @classmethod
    def local_image(cls, value):
        if value and not re.fullmatch(r"/media/[a-f0-9]{32}\.jpg", value):
            raise ValueError("Upload or import the image first.")
        return value

    @field_validator("theme")
    @classmethod
    def theme_name(cls, value):
        if value not in {"health", "politics", "other"}:
            raise ValueError("Choose Health, Politics or Other.")
        return value


class ManualClaim(BaseModel):
    text: str = Field(min_length=12, max_length=10000)


def article_record(identifier, admin=False):
    article = store.get(identifier)
    if not article:
        raise HTTPException(404, "Article not found.")
    return article


def public_article(article, listing=False):
    result = {
        key: value
        for key, value in article.items()
        if key not in {"rights_confirmed", "original_image_url"}
    }
    if listing:
        analysis = result.get("analysis") or {}
        result["analysis_status"] = analysis.get("remote_status") or analysis.get(
            "phase"
        )
        result["analysis_message"] = analysis.get("message", "")
        result.pop("analysis", None)
        result.pop("blocks", None)
        result["excerpt"] = result.pop("text")[:220]
    else:
        # External API payloads can contain diagnostic URLs or internal service errors.
        analysis = result.get("analysis")
        if analysis:
            article_info = dict(analysis.get("article") or {})
            if analysis.get("server_response"):
                _, saved_article, _ = normalise_result(analysis["server_response"])
                for key, value in saved_article.items():
                    if key not in article_info:
                        article_info[key] = value
                    elif isinstance(value, dict) and isinstance(article_info[key], dict):
                        article_info[key] = {**value, **article_info[key]}
            result["analysis"] = {
                **{
                    key: value
                    for key, value in analysis.items()
                    if key
                    not in {
                        "server_response",
                        "remote_analysis_id",
                        "server_source_analysis_id",
                    }
                },
                "article": article_info,
                "claims": [
                    {
                        key: value
                        for key, value in claim.items()
                        if key not in {"factiverse", "remote_analysis_id"}
                    }
                    for claim in analysis.get("claims", [])
                ],
            }
    return result


def modify(identifier, fn):
    store.change_analysis(identifier, fn)


def vital_client():
    return VitalClient(
        config.vital_api_base, config.vital_api_key, config.vital_client_version
    )


async def fetch_remote_result(
    client, remote_id, accepted=None, on_update=None, on_event=None
):
    if (
        accepted
        and accepted.get("cache_hit")
        and isinstance(accepted.get("cached_result"), dict)
    ):
        snapshot = {
            "status": "complete",
            "result": accepted["cached_result"],
            "analysis_id": remote_id,
        }
        if on_update:
            on_update(snapshot)
        return snapshot
    terminal_event = asyncio.Event()

    async def listen():
        cursor = "0-0"
        delay = 1
        while True:
            try:
                async for cursor_value, event in client.events(remote_id, after=cursor):
                    cursor = cursor_value
                    if on_event:
                        on_event(event)
                    if event.get("event_type") in {
                        "analysis.complete",
                        "analysis.partial",
                        "analysis.failed",
                    }:
                        terminal_event.set()
                        return
                await asyncio.sleep(delay)
            except VitalApiError:
                # Snapshots remain the authority; event transport failures must
                # not discard results or submit a second paid analysis.
                await asyncio.sleep(delay)
            delay = min(delay * 2, 10)

    stream_task = (
        asyncio.create_task(listen())
        if on_event and hasattr(client, "events")
        else None
    )
    started = time.monotonic()
    transient_failures = 0
    try:
        while time.monotonic() - started < config.vital_result_timeout_seconds:
            try:
                snapshot = await client.snapshot(remote_id)
                transient_failures = 0
            except VitalApiError as exc:
                if exc.code not in {"connection", "unavailable"}:
                    raise
                transient_failures += 1
                if transient_failures >= 3:
                    raise VitalApiError(
                        "The connection to VITAL was interrupted. Resume to check the existing analysis.",
                        "waiting",
                    ) from exc
                await asyncio.sleep(min(2**transient_failures, 8))
                continue
            status = result_status(snapshot)
            if on_update:
                on_update(snapshot)
            if status in {"complete", "partial"}:
                return snapshot
            if status == "failed":
                raise VitalApiError(
                    "The VITAL server reported a failed analysis. Other received results have been kept.",
                    "analysis_failed",
                )
            try:
                await asyncio.wait_for(
                    terminal_event.wait(), timeout=config.vital_poll_interval_seconds
                )
                terminal_event.clear()
            except TimeoutError:
                pass
        raise VitalApiError(
            "VITAL is taking longer than expected. Resume to retrieve this analysis; it will not be submitted again.",
            "waiting",
        )
    finally:
        if stream_task:
            stream_task.cancel()
            await asyncio.gather(stream_task, return_exceptions=True)


async def verify_claim(identifier, claim_id):
    record = store.get(identifier)
    if not record or not record["analysis"]:
        return
    analysis_id = record["analysis"]["analysis_id"]
    claim = next(
        (item for item in record["analysis"]["claims"] if item["id"] == claim_id), None
    )
    if not claim or claim["status"] not in {"pending", "error", "skipped"}:
        return

    def set_claim(current, updates):
        if not current or current["analysis_id"] != analysis_id:
            return current
        for item in current["claims"]:
            if item["id"] == claim_id:
                item.update(updates)
        current["updated_at"] = now()
        return current

    modify(
        identifier,
        lambda current: set_claim(
            current,
            {
                "status": "checking",
                "explanation": "The VITAL server is analysing this passage.",
            },
        ),
    )
    try:
        async with remote_slots:
            client = vital_client()
            accepted = None
            remote_id = claim.get("remote_analysis_id")
            if not remote_id:
                accepted = await client.submit(
                    submission_payload(
                        record,
                        config.demo_public_url,
                        claim["text"],
                        claim.get("theme"),
                    )
                )
                remote_id = accepted["analysis_id"]
                modify(
                    identifier,
                    lambda current: set_claim(
                        current, {"remote_analysis_id": remote_id}
                    ),
                )
            snapshot = await fetch_remote_result(client, remote_id, accepted)
            claims, _, _ = normalise_result(snapshot)
            matched = next(
                (
                    item
                    for item in claims
                    if " ".join(item["text"].split()).lower()
                    == " ".join(claim["text"].split()).lower()
                ),
                None,
            )
            if matched is None:
                raise VitalApiError(
                    "VITAL did not return a matching assessment for the selected passage."
                )
            updates = {
                **matched,
                "id": claim_id,
                "text": claim["text"],
                "remote_analysis_id": remote_id,
            }
    except Exception as exc:
        print(
            f"VITAL passage request error: {str(exc) if isinstance(exc, VitalApiError) else type(exc).__name__}"
        )
        updates = {
            "status": "error",
            "status_label": "Check failed",
            "explanation": (
                str(exc)
                if isinstance(exc, VitalApiError)
                else "The passage check could not finish. The server did not provide a reason."
            ),
            "error": True,
        }
    modify(identifier, lambda current: set_claim(current, updates))


async def run_analysis(identifier, prepared=False, features=None):
    try:
        async with article_slots:
            record = store.get(identifier)
            previous = record["analysis"] or {}
            analysis_id = previous.get("analysis_id") or uuid4().hex
            remote_id = previous.get("remote_analysis_id")
            modify(
                identifier,
                lambda current: {
                    **(current or {}),
                    "analysis_id": analysis_id,
                    "phase": "detecting",
                    "claims": previous.get("claims", []),
                    "article": previous.get("article", {}),
                    "article_ready": False,
                    "warnings": [],
                    "started_at": previous.get("started_at") or now(),
                    "message": "Submitting article to VITAL.",
                },
            )
            client = vital_client()
            accepted = None
            if not remote_id:
                accepted = await client.submit(
                    submission_payload(record, config.demo_public_url)
                )
                remote_id = accepted["analysis_id"]
                modify(
                    identifier,
                    lambda current: {
                        **current,
                        "remote_analysis_id": remote_id,
                        "server_cache_hit": bool(accepted.get("cache_hit")),
                        "server_source_analysis_id": accepted.get("source_analysis_id"),
                    },
                )

            progress = CoordinatorProgress()

            def publish_event(event):
                partial = progress.consume(event)
                if not partial:
                    return
                claims, article = partial["claims"], partial["article"]
                if features is not None:
                    claims, article = prepared_results(claims, article, features)

                def update(current):
                    if not current or current["analysis_id"] != analysis_id:
                        return current
                    current.update(
                        message=partial["message"],
                        progress_stage=partial["stage"],
                        detected_count=partial["detected_count"],
                        checked_count=partial["checked_count"],
                        updated_at=now(),
                    )
                    if claims:
                        current["claims"] = claims
                    available = {
                        key: value
                        for key, value in article.items()
                        if value is not None and value != []
                    }
                    current["article"] = {**current.get("article", {}), **available}
                    return current

                modify(identifier, update)

            def publish(snapshot):
                status = result_status(snapshot)
                claims, article, warnings = normalise_result(snapshot)
                if features is not None:
                    claims, article = prepared_results(claims, article, features)
                if status == "partial":
                    warnings.append(
                        "VITAL completed with partial results. Some outputs may be unavailable."
                    )

                def update(current):
                    if not current or current["analysis_id"] != analysis_id:
                        return current
                    current.update(
                        prepared_features=features,
                        remote_status=status,
                        server_response=snapshot,
                        message=(
                            (
                                current.get("message")
                                if current.get("progress_stage")
                                else (
                                    "Waiting in the server queue."
                                    if status == "queued"
                                    else "Processing article."
                                )
                            )
                            if status in {"queued", "running"}
                            else "Results received from VITAL."
                        ),
                        phase=(
                            "detecting"
                            if status == "queued"
                            else (
                                "checking"
                                if status == "running"
                                else (
                                    "completed"
                                    if status in {"complete", "partial"}
                                    else "failed"
                                )
                            )
                        ),
                        warnings=warnings,
                        updated_at=now(),
                    )
                    # Some snapshots only contain progress. Keep already-received data.
                    if claims:
                        current["claims"] = claims
                    if article:
                        if status in {"complete", "partial"}:
                            current["article"] = article
                        else:
                            current["article"] = {
                                **current.get("article", {}),
                                **{
                                    key: value
                                    for key, value in article.items()
                                    if value is not None and value != []
                                },
                            }
                    current["article_ready"] = status in {"complete", "partial"}
                    return current

                modify(identifier, update)

            snapshot = await fetch_remote_result(
                client, remote_id, accepted, publish, publish_event
            )
            modify(
                identifier,
                lambda current: {
                    **current,
                    "phase": "completed",
                    "completed_at": now(),
                    "message": "Results received from VITAL.",
                    "partial": result_status(snapshot) == "partial",
                },
            )
            if prepared:
                store.prepared(identifier)
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        print(
            f"VITAL remote analysis error: {str(exc) if isinstance(exc, VitalApiError) else type(exc).__name__}",
            flush=True,
        )
        modify(
            identifier,
            lambda current: {
                **(current or {}),
                "phase": (
                    "interrupted"
                    if isinstance(exc, VitalApiError) and exc.code == "waiting"
                    else "failed"
                ),
                "error_code": (
                    exc.code if isinstance(exc, VitalApiError) else "internal"
                ),
                "message": (
                    str(exc)
                    if isinstance(exc, VitalApiError)
                    else "The VITAL request could not finish."
                ),
            },
        )
    finally:
        tasks.pop(identifier, None)


def start_analysis(identifier, prepared=False, features=None):
    if identifier in tasks:
        return
    if len(tasks) >= 10:
        raise HTTPException(429, "The demo is busy. Try again shortly.")
    modify(
        identifier,
        lambda current: {
            **(current or {}),
            "phase": "detecting",
            "remote_status": "queued",
            "message": "Queued for analysis.",
            "updated_at": now(),
        },
    )
    tasks[identifier] = asyncio.create_task(
        run_analysis(identifier, prepared, features)
    )


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "version": "1.12.0",
        "vital_api_configured": bool(config.vital_api_key),
        "analysis_service": config.vital_api_base,
    }


@app.get("/")
@app.get("/article/{identifier}")
async def home(identifier: str = ""):
    return FileResponse(web / "index.html")


@app.get("/admin")
async def admin_page():
    return FileResponse(web / "admin.html")


@app.post("/api/admin/login")
async def login(body: Login, request: Request, response: Response):
    ip = request.client.host
    attempts = [
        stamp for stamp in login_attempts.get(ip, []) if stamp > time.monotonic() - 60
    ]
    if len(attempts) >= 8:
        raise HTTPException(429, "Too many attempts. Wait one minute.")
    attempts.append(time.monotonic())
    login_attempts[ip] = attempts
    if not hmac.compare_digest(
        body.password.encode(), config.demo_admin_password.encode()
    ):
        raise HTTPException(401, "Incorrect password.")
    token = secrets.token_urlsafe(32)
    sessions[token] = time.monotonic() + 43200
    response.set_cookie(
        "vital_organizer",
        token,
        httponly=True,
        samesite="strict",
        secure=config.demo_secure_cookies,
        max_age=43200,
    )
    return {"signed_in": True}


@app.post("/api/admin/logout")
async def logout(request: Request, response: Response):
    sessions.pop(request.cookies.get("vital_organizer"), None)
    response.delete_cookie("vital_organizer")
    return {"signed_in": False}


@app.get("/api/admin/articles", dependencies=[Depends(organizer)])
async def admin_articles():
    return store.list()


@app.get("/api/admin/share", dependencies=[Depends(organizer)])
async def share_address(request: Request):
    return {"url": config.demo_public_url or str(request.base_url).rstrip("/")}


@app.get(
    "/api/admin/articles/{identifier}/server-response",
    dependencies=[Depends(organizer)],
)
async def saved_server_response(identifier: str):
    record = article_record(identifier, admin=True)
    return (record.get("analysis") or {}).get("server_response") or {}


@app.post("/api/admin/qr", dependencies=[Depends(organizer)])
async def qr_code(body: URLInput):
    parsed = urlparse(body.url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise HTTPException(422, "Enter the complete visitor URL.")
    output = BytesIO()
    qrcode.make(body.url).save(output, format="PNG")
    return Response(
        output.getvalue(),
        media_type="image/png",
        headers={"Content-Disposition": 'attachment; filename="VITAL-demo-QR.png"'},
    )


@app.post("/api/admin/import", dependencies=[Depends(organizer)])
async def import_url(body: URLInput):
    try:
        return await import_article(body.url, media)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            422,
            "The article could not be imported. Check the URL or paste the text manually.",
        ) from exc


@app.post("/api/admin/image", dependencies=[Depends(organizer)])
async def upload_image(file: UploadFile = File(...)):
    body = await file.read(8_000_001)
    try:
        return {"image_url": image_snapshot(body, media)}
    except Exception as exc:
        raise HTTPException(
            422, "Use a PNG, JPEG, WebP or GIF image smaller than 8 MB."
        ) from exc


@app.post("/api/admin/articles", dependencies=[Depends(organizer)])
async def create_article(body: ArticleInput):
    return store.save(body.model_dump())


@app.put("/api/admin/articles/{identifier}", dependencies=[Depends(organizer)])
async def edit_article(identifier: str, body: ArticleInput):
    article_record(identifier, admin=True)
    if identifier in tasks:
        raise HTTPException(
            409, "Wait for analysis to finish before editing this snapshot."
        )
    return store.save(body.model_dump(), identifier)


@app.delete("/api/admin/articles/{identifier}", dependencies=[Depends(organizer)])
async def delete_article(identifier: str):
    if identifier in tasks:
        raise HTTPException(409, "Wait for analysis to finish before deleting.")
    store.delete(identifier)
    return {"deleted": True}


@app.post("/api/admin/articles/{identifier}/prepare", dependencies=[Depends(organizer)])
async def prepare_article(identifier: str):
    record = article_record(identifier, admin=True)
    if identifier in tasks:
        return {
            "started": False,
            "already_running": True,
            "status": (record.get("analysis") or {}).get("remote_status", "queued"),
        }
    store.reset_analysis(identifier)
    start_analysis(identifier, prepared=True)
    return {"started": True, "upstream_scope": "full_article"}


def prepared_results(claims, article, features):
    fields = {
        "classification": {
            "category",
            "claim_classification",
            "topics",
            "main_topic",
            "descriptive_topic",
            "topic_reason",
        },
        "advertorial": {"advertorial"},
        "sentiment": {"title_sentiment", "content_sentiment", "framing_difference"},
        "provider": {"provider"},
        "transformation": {
            "transformation",
            "word_count",
            "summary_generated",
            "entities_persons",
            "entities_organizations",
            "entities_locations",
            "entities_misc",
            "entities_medical",
            "n_medical_terms",
            "model_metadata",
        },
    }
    selected = set().union(*(fields.get(feature, set()) for feature in features))
    return claims if "claims" in features else [], {
        key: value
        for key, value in article.items()
        if key in selected or key == "unavailable"
    }


@app.post("/api/demo/import")
async def visitor_import(body: URLInput):
    try:
        data = await import_article(body.url, media)
        if len(data["text"]) < 120 or not data["title"]:
            raise ValueError(
                "The article text could not be extracted. Ask an organizer to add it manually."
            )
        payload = ArticleInput.model_validate(data).model_dump()
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            422,
            "This site could not be imported. Ask an organizer to add the article manually.",
        ) from exc
    existing = next(
        (
            item
            for item in store.list(public=True)
            if item["url"] == payload["url"] and item["text"] == payload["text"]
        ),
        None,
    )
    record = existing or store.save(payload)
    if not record.get("analysis") or record["analysis"].get("phase") != "completed":
        start_analysis(record["id"])
    return {"id": record["id"], "warnings": data.get("warnings", [])}


@app.post("/api/widget/articles")
async def widget_article(body: ArticleInput):
    # Extension articles are not part of the public news catalogue.
    existing = next(
        (
            item
            for item in store.list()
            if item.get("widget_only")
            and item["url"] == body.url
            and item["text"] == body.text
            and item["title"] == body.title
        ),
        None,
    )
    record = existing or store.save({**body.model_dump(), "widget_only": True})
    return public_article(record)


@app.get("/api/admin/feedback", dependencies=[Depends(organizer)])
async def feedback_export():
    path = Path(config.vital_feedback_db)
    if not path.exists():
        return []
    with sqlite3.connect(path) as db:
        db.row_factory = sqlite3.Row
        rows = [dict(row) for row in db.execute("SELECT * FROM feedback ORDER BY id")]
    for row in rows:
        row["context"] = json.loads(row.pop("context_json", "{}"))
    return rows


@app.get("/api/demo/articles")
async def articles():
    return [public_article(item, listing=True) for item in store.list(public=True)]


@app.get("/api/demo/articles/{identifier}")
async def article(identifier: str):
    return public_article(article_record(identifier))


@app.post("/api/demo/articles/{identifier}/analyse")
async def begin(identifier: str):
    record = article_record(identifier)
    if record["analysis"] and record["analysis"].get("phase") == "completed":
        if record["analysis"].get("prepared_features") is not None:
            claims, article, warnings = normalise_result(
                record["analysis"].get("server_response", {})
            )
            modify(
                identifier,
                lambda current: {
                    **current,
                    "claims": claims,
                    "article": article,
                    "prepared_features": None,
                },
            )
        return {"cached": True}
    if identifier in tasks:
        return {"started": False, "already_running": True}
    start_analysis(identifier)
    return {"started": True}


@app.post("/api/demo/articles/{identifier}/claims/{claim_id}/check")
async def check_extra(identifier: str, claim_id: str):
    record = article_record(identifier)
    if not record["analysis"] or record["analysis"].get("phase") != "completed":
        raise HTTPException(409, "Wait for the first checks to finish.")
    claim = next(
        (item for item in record["analysis"]["claims"] if item["id"] == claim_id), None
    )
    if not claim:
        raise HTTPException(404, "Claim not found.")
    await verify_claim(identifier, claim_id)
    return {"checked": True}


@app.post("/api/demo/articles/{identifier}/claims")
async def add_claim(identifier: str, body: ManualClaim):
    record = article_record(identifier)
    if not record["analysis"] or record["analysis"].get("phase") != "completed":
        raise HTTPException(409, "Analyse the article first.")
    normalized = " ".join(body.text.split())
    if normalized not in " ".join(record["text"].split()):
        raise HTTPException(422, "Select the claim from this article.")
    existing = next(
        (claim for claim in record["analysis"]["claims"] if " ".join(claim["text"].split()) == normalized),
        None,
    )
    if existing:
        return {"claim_id": existing["id"]}
    identifier_claim = uuid4().hex[:12]
    candidate = {
        "id": identifier_claim,
        "text": normalized,
        "theme": record["theme"],
        "status": "pending",
        "status_label": "Not checked",
        "explanation": "Select this claim to check it.",
        "evidence": [],
    }

    def add(current):
        current["claims"].append(candidate)
        return current

    modify(identifier, add)
    return {"claim_id": identifier_claim}


@app.post("/api/demo/articles/{identifier}/feedback")
async def feedback(identifier: str, body: FeedbackRequest):
    record = article_record(identifier)
    analysis = record["analysis"]
    if not analysis or body.analysis_id != analysis.get("analysis_id"):
        raise HTTPException(409, "Refresh this article before sending feedback.")
    if (
        body.feature in {"claim", "claim_classification"}
        and body.claim_id
        and body.claim_id
        not in (
            {claim["id"] for claim in analysis["claims"]}
            | {
                item.get("claim_id")
                for item in analysis.get("article", {}).get("claim_classification", [])
            }
        )
    ):
        raise HTTPException(422, "Unknown claim.")
    if body.feature not in {"claim", "claim_classification"} and body.claim_id:
        raise HTTPException(422, "Only claim feedback may include a claim identifier.")
    # Record the actual output the participant evaluated, not a later recomputation.
    claim = next(
        (item for item in analysis["claims"] if item["id"] == body.claim_id), None
    )
    if not claim and body.claim_id:
        claim = next(
            (
                item
                for item in analysis.get("article", {}).get("claim_classification", [])
                if item.get("claim_id") == body.claim_id
            ),
            None,
        )
    context = {
        "article_id": identifier,
        "article_title": record["title"],
        "url": record["url"],
        "analysis_updated_at": analysis.get("updated_at"),
        "claim": claim,
        "article_result": analysis.get("article", {}) if not claim else None,
    }
    return await asyncio.to_thread(
        save_feedback, config.vital_feedback_db, body, context
    )
