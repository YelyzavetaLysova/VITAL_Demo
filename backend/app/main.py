import hashlib
import json
import asyncio
import time
from dataclasses import dataclass, field
from uuid import uuid4

from cachetools import TTLCache
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .pipeline import analyse
from . import article_analysis
from .article_analysis import analyse_article as run_article_analysis
from .schemas import AnalyseRequest, AnalyseResponse, JobCreated, JobStatus


settings = get_settings()
cache: TTLCache = TTLCache(maxsize=256, ttl=settings.cache_ttl_seconds)
app = FastAPI(title="VITAL Browser API", version="0.3.0")
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
    message: str = "Waiting to start analysis."
    started_at: float = field(default_factory=time.monotonic)
    completed_claims: int = 0
    total_claims: int | None = None
    result: AnalyseResponse | None = None
    error: str | None = None


jobs: dict[str, AnalysisJob] = {}


@app.get("/health")
async def health() -> dict:
    return {
        "status": "ok",
        "mode": "live" if settings.factiverse_api_key and not settings.vital_demo_mode else "demo",
        "capabilities": {
            "factiverse": bool(settings.factiverse_api_key) and not settings.vital_demo_mode,
            "article_models": settings.vital_enable_ml,
            "provider_metadata": bool(article_analysis._provider_rows(settings.vital_provider_csv)),
        },
    }


async def build_analysis(
    request: AnalyseRequest,
    job: AnalysisJob | None = None,
) -> AnalyseResponse:
    cache_key = hashlib.sha256(json.dumps(request.model_dump(mode="json"), sort_keys=True).encode()).hexdigest()
    if cache_key in cache:
        if job is not None:
            job.phase = "cache"
            job.message = "Loaded a recent result from the analysis cache."
        return cache[cache_key]

    loop = asyncio.get_running_loop()

    async def claim_progress(
        phase: str,
        message: str,
        completed_claims: int,
        total_claims: int | None,
    ) -> None:
        if job is not None:
            job.phase = phase
            job.message = message
            job.completed_claims = completed_claims
            job.total_claims = total_claims

    def article_progress(phase: str, message: str) -> None:
        if job is not None:
            loop.call_soon_threadsafe(
                update_article_progress,
                job,
                phase,
                message,
            )

    try:
        claims_task = analyse(request, settings, claim_progress)
        article_task = asyncio.to_thread(
            run_article_analysis,
            request.title,
            request.text,
            str(request.url) if request.url else None,
            settings,
            article_progress,
        )
        (claims, warnings, mode), article = await asyncio.gather(claims_task, article_task)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Analysis failed: {exc}") from exc
    response = AnalyseResponse(
        analysis_id=str(uuid4()),
        mode=mode,
        claims=claims,
        warnings=warnings,
        pipeline={
            "claim_detection": "Factiverse" if mode == "live" else "local fallback",
            "claim_selection": "Factiverse detected claims",
            "evidence_alignment": "Factiverse stance detection" if mode == "live" else "not run",
            "max_claims": settings.vital_max_claims,
        },
        article=article,
    )
    cache[cache_key] = response
    return response


def update_article_progress(
    job: AnalysisJob,
    phase: str,
    message: str,
) -> None:
    job.phase = phase
    job.message = message


async def run_job(job: AnalysisJob, request: AnalyseRequest) -> None:
    job.status = "running"
    job.phase = "starting"
    job.message = "Starting article analysis."

    try:
        job.result = await build_analysis(request, job)
        job.status = "completed"
        job.phase = "completed"
        job.message = "Analysis completed."
    except Exception as exc:
        job.status = "failed"
        job.phase = "failed"
        job.message = "Analysis failed."
        job.error = str(exc)


@app.post("/v1/analyse", response_model=AnalyseResponse)
async def analyse_article(request: AnalyseRequest) -> AnalyseResponse:
    try:
        return await build_analysis(request)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Analysis failed: {exc}") from exc


@app.post("/v1/analyse/jobs", response_model=JobCreated)
async def create_analysis_job(request: AnalyseRequest) -> JobCreated:
    job_id = str(uuid4())
    job = AnalysisJob(job_id=job_id)
    jobs[job_id] = job
    asyncio.create_task(run_job(job, request))
    return JobCreated(job_id=job_id, status="queued")


@app.get("/v1/analyse/jobs/{job_id}", response_model=JobStatus)
async def get_analysis_job(job_id: str) -> JobStatus:
    job = jobs.get(job_id)

    if job is None:
        raise HTTPException(status_code=404, detail="Analysis job was not found.")

    return JobStatus(
        job_id=job.job_id,
        status=job.status,
        phase=job.phase,
        message=job.message,
        elapsed_seconds=round(time.monotonic() - job.started_at, 1),
        completed_claims=job.completed_claims,
        total_claims=job.total_claims,
        result=job.result,
        error=job.error,
    )
