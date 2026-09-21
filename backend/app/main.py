import asyncio
import hashlib
import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from uuid import uuid4

from cachetools import TTLCache
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .article_analysis import _provider_rows, analyse_article
from .config import get_settings
from .feedback import save_feedback
from .pipeline import analyse
from .schemas import (
    AnalyseRequest,
    AnalyseResponse,
    ArticleAnalysis,
    FeedbackRequest,
    JobCreated,
    JobStatus,
)

settings = get_settings()
cache = TTLCache(maxsize=256, ttl=settings.cache_ttl_seconds)
model_lock = asyncio.Lock()
app = FastAPI(title="VITAL API", version="0.5.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


@dataclass
class AnalysisJob:
    job_id: str
    status: str = "queued"
    phase: str = "queued"
    message: str = "Waiting to start."
    started_at: float = field(default_factory=time.monotonic)
    finished_at: float | None = None
    completed_claims: int = 0
    total_claims: int | None = None
    claims_finished: bool = False
    claim_message: str = "Waiting to find claims."
    article_message: str = "Waiting for article classifiers."
    result: AnalyseResponse | None = None
    error: str | None = None


jobs: dict[str, AnalysisJob] = {}


@app.get("/health")
async def health() -> dict:
    return {
        "status": "ok",
        "mode": (
            "live"
            if settings.factiverse_api_key and not settings.vital_demo_mode
            else "demo"
        ),
        "capabilities": {
            "factiverse": bool(settings.factiverse_api_key)
            and not settings.vital_demo_mode,
            "article_models": settings.vital_enable_ml,
            "provider_metadata": bool(_provider_rows(settings.vital_provider_csv)),
            "feedback": True,
        },
    }


def make_response(claims, warnings, mode, article) -> AnalyseResponse:
    return AnalyseResponse(
        analysis_id=str(uuid4()),
        mode=mode,
        claims=claims,
        warnings=warnings,
        pipeline={
            "claim_detection": (
                "Factiverse" if mode == "live" else "local sentence fallback"
            ),
            "evidence_alignment": "Factiverse" if mode == "live" else "not run",
            "max_claims": settings.vital_max_claims,
        },
        article=article,
    )


async def build_analysis(request: AnalyseRequest, job=None) -> AnalyseResponse:
    cache_key = hashlib.sha256(
        json.dumps(request.model_dump(mode="json"), sort_keys=True).encode()
    ).hexdigest()
    if cache_key in cache:
        return cache[cache_key]
    loop = asyncio.get_running_loop()

    async def claim_progress(phase, message, completed, total):
        if job:
            job.phase = phase
            job.message = message
            job.claim_message = message
            job.completed_claims = completed
            job.total_claims = total

    def set_article_progress(phase, message):
        if job:
            job.article_message = message
            if job.claims_finished:
                job.phase = phase
                job.message = message

    def article_progress(phase, message):
        loop.call_soon_threadsafe(set_article_progress, phase, message)

    async def classify_article():
        article_progress("models", "Waiting for the article classifier.")
        async with model_lock:
            return await asyncio.to_thread(
                analyse_article,
                request.title,
                request.text,
                str(request.url) if request.url else None,
                settings,
                article_progress,
                request.options,
            )

    article_task = asyncio.create_task(classify_article())
    try:
        claims, warnings, mode = await analyse(request, settings, claim_progress)
        response = make_response(claims, warnings, mode, ArticleAnalysis())
        if job:
            # Publish one complete result, not temporary classifier sections.
            job.claims_finished = True
            job.claim_message = "Claim checks completed."
            job.message = job.article_message
            job.phase = "article"
        response.article = await article_task
        cache[cache_key] = response
        return response
    except Exception as exc:
        # Keep the model lock until its underlying thread has finished.
        await article_task
        raise HTTPException(status_code=502, detail=f"Analysis failed: {exc}") from exc


async def run_job(job, request):
    job.status = "running"
    try:
        job.result = await build_analysis(request, job)
        job.status = "completed"
        job.phase = "completed"
        job.message = "Analysis completed."
        job.article_message = "Article analysis completed."
        job.claim_message = "Claim checks completed."
    except Exception as exc:
        job.status = "failed"
        job.phase = "failed"
        job.error = str(exc)
    finally:
        job.finished_at = time.monotonic()


@app.post("/v1/analyse", response_model=AnalyseResponse)
async def analyse_endpoint(request: AnalyseRequest):
    return await build_analysis(request)


@app.post("/v1/analyse/jobs", response_model=JobCreated)
async def create_job(request: AnalyseRequest):
    now = time.monotonic()
    expired = [
        key
        for key, job in jobs.items()
        if job.finished_at and now - job.finished_at > 43200
    ]
    for key in expired:
        del jobs[key]
    if sum(job.status in ("queued", "running") for job in jobs.values()) >= 16:
        raise HTTPException(429, "Too many analyses are already running.")
    job = AnalysisJob(job_id=str(uuid4()))
    jobs[job.job_id] = job
    asyncio.create_task(run_job(job, request))
    return JobCreated(job_id=job.job_id, status="queued")


@app.get("/v1/analyse/jobs/{job_id}", response_model=JobStatus)
async def get_job(job_id: str):
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(
            404, "Analysis expired or the server restarted. Please scan again."
        )
    return JobStatus(
        job_id=job.job_id,
        status=job.status,
        phase=job.phase,
        message=job.message,
        elapsed_seconds=round(
            (job.finished_at or time.monotonic()) - job.started_at, 1
        ),
        completed_claims=job.completed_claims,
        total_claims=job.total_claims,
        result=job.result,
        error=job.error,
        claim_message=job.claim_message,
        article_message=job.article_message,
    )


@app.post("/v1/feedback")
async def feedback_endpoint(feedback: FeedbackRequest):
    responses = list(cache.values()) + [
        job.result for job in jobs.values() if job.result
    ]
    result = next(
        (item for item in responses if item.analysis_id == feedback.analysis_id), None
    )
    if result is None:
        raise HTTPException(
            404, "Analysis expired. Scan again before sending feedback."
        )
    if feedback.feature == "claim":
        if feedback.claim_id not in {claim.id for claim in result.claims}:
            raise HTTPException(422, "Feedback must refer to a claim in this analysis.")
    elif feedback.claim_id:
        raise HTTPException(422, "Only claim feedback can include a claim identifier.")
    return await asyncio.to_thread(save_feedback, settings.vital_feedback_db, feedback)


# Shared responsive UI; non-extension browsers use paste-text input.
ui_path = Path(__file__).resolve().parents[2] / "extension"
if ui_path.is_dir():
    app.mount("/app", StaticFiles(directory=ui_path, html=True), name="companion")
