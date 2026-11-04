from typing import Any, Literal

from pydantic import BaseModel, Field, HttpUrl, field_validator, model_validator


class AnalysisOptions(BaseModel):
    topics: bool = True
    advertorial: bool = True
    sentiment: bool = True
    provider: bool = True


class AnalyseRequest(BaseModel):
    url: HttpUrl | None = None
    title: str = ""
    text: str = Field(min_length=12, max_length=120_000)
    selected_text: str | None = Field(default=None, max_length=10_000)
    language: str = "en"
    theme: Literal["health", "politics", "other"] = "other"
    options: AnalysisOptions = Field(default_factory=AnalysisOptions)

    @field_validator("language")
    @classmethod
    def normalise_language(cls, value: str) -> str:
        return (value or "en").split("-")[0].lower()


class EvidenceItem(BaseModel):
    title: str
    publisher: str | None = None
    url: str | None = None
    date: str | None = None
    passage: str | None = None
    stance: Literal[
        "supports",
        "contradicts",
        "mixed",
        "insufficient",
        "qualifies",
        "mentions",
        "unknown",
    ] = "unknown"
    source_type: str | None = None
    stance_score: float | None = None
    similarity_score: float | None = None
    exact_match: bool | None = None
    citation_count: int | None = None
    language: str | None = None
    authors: list[str] = []
    keywords: list[str] = []
    preferred_site: bool | None = None
    original_query: str | None = None
    translated: bool | None = None
    translated_query: str | None = None
    rewritten_query: str | None = None
    predicted_label: int | None = None
    softmax_score: list[float] = []
    detailed_label: str | None = None
    reliability: str | None = None
    bias: str | None = None
    bias_source_url: str | None = None
    trust_score: float | None = None
    trust_score_source: str | None = None
    factiverse: dict[str, Any] = {}


class ClaimResult(BaseModel):
    id: str
    text: str
    start: int | None = None
    end: int | None = None
    detection_score: float | None = None
    checkworthiness: float | None = None
    status: Literal[
        "pending",
        "checking",
        "supported",
        "contradicted",
        "mixed",
        "insufficient",
        "context_needed",
    ]
    status_label: str
    explanation: str
    evidence: list[EvidenceItem] = []
    raw_prediction: str | None = None
    final_score: float | None = None
    final_label: str | None = None
    resolved_claim: str | None = None
    summary: Any | None = None
    advanced_summary: Any | None = None
    suggested_fix: Any | None = None
    label_map: dict[str, int] = {}
    factiverse: dict[str, Any] = {}


class TopicResult(BaseModel):
    label: str
    score: float


class SentimentResult(BaseModel):
    label: str
    score: float


class AdvertorialResult(BaseModel):
    label: str
    score: float


class ProviderResult(BaseModel):
    name: str | None = None
    domain: str
    credibility: str | float | None = None
    bias: str | None = None
    country: str | None = None
    source: str = "VITAL provider metadata"


class ArticleAnalysis(BaseModel):
    topics: list[TopicResult] = []
    advertorial: AdvertorialResult | None = None
    title_sentiment: SentimentResult | None = None
    content_sentiment: SentimentResult | None = None
    framing_difference: str | None = None
    provider: ProviderResult | None = None
    unavailable: list[str] = []


class AnalyseResponse(BaseModel):
    analysis_id: str
    mode: Literal["live", "demo"]
    claims: list[ClaimResult]
    warnings: list[str] = []
    pipeline: dict[str, Any]
    article: ArticleAnalysis = ArticleAnalysis()


class JobCreated(BaseModel):
    job_id: str
    status: Literal["queued", "running"]


class JobStatus(BaseModel):
    job_id: str
    status: Literal["queued", "running", "completed", "failed"]
    phase: str
    message: str
    elapsed_seconds: float
    completed_claims: int = 0
    total_claims: int | None = None
    result: AnalyseResponse | None = None
    error: str | None = None
    claim_message: str = ""
    article_message: str = ""


class FeedbackRequest(BaseModel):
    analysis_id: str = Field(min_length=1, max_length=64)
    client_id: str = Field(min_length=16, max_length=64, pattern=r"^[a-zA-Z0-9-]+$")
    feature: Literal[
        "historical_insights",
        "claim",
        "detection",
        "topics",
        "advertorial",
        "sentiment",
        "provider",
        "system",
        "category",
        "claim_classification",
        "title_sentiment",
        "content_sentiment",
        "framing",
        "transformation",
        "word_count",
        "entities",
        "medical_entities",
    ]
    claim_id: str = Field(default="", max_length=64)
    rating: Literal[
        "helpful", "not_helpful", "correct", "incorrect", "unsure", "comment"
    ]
    comment: str = Field(default="", max_length=2000)

    @model_validator(mode="after")
    def meaningful_comment(self):
        if self.rating == "comment" and not self.comment.strip():
            raise ValueError("Write a comment or select a rating.")
        return self

    @field_validator("comment")
    @classmethod
    def trim_comment(cls, value: str) -> str:
        return value.strip()
