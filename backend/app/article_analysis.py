import csv
from functools import lru_cache
from pathlib import Path
from collections.abc import Callable
from typing import Any
from urllib.parse import urlparse

from .config import Settings
from .schemas import AdvertorialResult, ArticleAnalysis, ProviderResult, SentimentResult, TopicResult


HEALTH_TOPICS = [
    "health and beauty product", "healthcare industry", "health care provider", "medical equipment",
    "pharmaceutical", "disease and condition", "cancer", "communicable disease", "epidemic and pandemic",
    "pandemic", "plague disease", "viral disease", "HIV and AIDS", "developmental disorder", "heart disease",
    "illness", "injury", "medical condition", "obesity", "mental health and disorder", "anxiety and stress",
    "depression", "eating disorder", "government health care", "Medicaid", "Medicare", "health facility",
    "healthcare clinic", "hospital", "health insurance", "health organisation", "health treatment and procedure",
    "diet", "dietary supplement", "drug rehabilitation", "emergency care", "health care approach",
    "conventional medicine", "herbal medicine", "holistic medicine", "traditional Chinese medicine", "medical test",
    "non-prescription drug", "physical fitness", "prescription drug", "preventative medicine", "surgery", "therapy",
    "vaccine", "medical profession", "medical service", "medical specialisation", "dentistry", "eye care",
    "general practice", "geriatric medicine", "oncology", "orthopaedics", "paediatrics", "pharmacology",
    "psychiatry", "radiology", "reproductive medicine", "surgical medicine", "veterinary medicine", "medical staff",
    "private health care", "public health", "workplace health and safety", "vegetarianism and veganism", "wellness",
    "exercise and fitness", "mental wellbeing", "healthcare policy", "biomedical science", "medical research",
    "psychology", "addiction", "death and dying", "euthanasia", "assisted suicide", "elderly care", "long-term care",
    "bodybuilding", "drug use in sport", "drug abuse in sport", "drug testing in sport", "medical drug use in sport",
    "drowning", "court-ordered psychiatric treatment", "drug related crimes", "drug trafficking", "organic food",
    "food and drink regulations", "disabilities", "abortion", "contraception", "pregnancy and childbirth",
    "parenting", "abusive behaviour", "suicide", "child care", "sleep", "gynecology", "contract issue-healthcare",
]


@lru_cache(maxsize=2)
def load_zero_shot(model_name: str):
    from transformers import pipeline
    return pipeline("zero-shot-classification", model=model_name, device=-1)


@lru_cache(maxsize=2)
def load_sentiment(model_name: str):
    from transformers import pipeline
    return pipeline("sentiment-analysis", model=model_name, device=-1)


def _clip(text: str, words: int = 384) -> str:
    return " ".join(text.split()[:words])


def _normalise_sentiment(raw: dict[str, Any]) -> SentimentResult:
    label = str(raw.get("label") or "unknown").lower().replace("label_0", "negative").replace("label_1", "positive")
    return SentimentResult(label=label, score=float(raw.get("score") or 0))


def _framing(title: SentimentResult, body: SentimentResult) -> str:
    if title.label == body.label:
        gap = abs(title.score - body.score)
        return "similar tone" if gap < 0.25 else "different intensity"
    if title.label == "negative" and body.label == "positive":
        return "headline is more negative than the article body"
    if title.label == "positive" and body.label == "negative":
        return "headline is more positive than the article body"
    return "headline and article body have different sentiment"


@lru_cache(maxsize=8)
def _provider_rows(path: str) -> list[dict[str, str]]:
    csv_path = Path(path)
    if not csv_path.exists():
        return []
    with csv_path.open(encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def provider_lookup(url: str | None, path: str) -> ProviderResult | None:
    if not url:
        return None
    domain = (urlparse(url).hostname or "").lower().removeprefix("www.")
    for row in _provider_rows(path):
        candidate = str(row.get("domain") or row.get("url") or "").lower().removeprefix("www.").rstrip("/")
        if candidate.startswith("http"):
            candidate = (urlparse(candidate).hostname or "").removeprefix("www.")
        if candidate and (domain == candidate or domain.endswith(f".{candidate}")):
            credibility: str | float | None = row.get("credibility") or None
            if credibility:
                try: credibility = float(credibility)
                except ValueError: pass
            return ProviderResult(
                name=row.get("name") or row.get("provider") or None,
                domain=domain,
                credibility=credibility,
                bias=row.get("bias") or None,
                country=row.get("country") or None,
            )
    return None


ArticleProgress = Callable[[str, str], None]


def analyse_article(
    title: str,
    text: str,
    url: str | None,
    settings: Settings,
    progress: ArticleProgress | None = None,
) -> ArticleAnalysis:
    def report(phase: str, message: str) -> None:
        if progress is not None:
            progress(phase, message)

    unavailable: list[str] = []
    report("publisher", "Looking up publisher metadata.")
    provider = provider_lookup(url, settings.vital_provider_csv)
    if provider is None:
        unavailable.append("provider metadata")
    if not settings.vital_enable_ml:
        unavailable.extend(["health-topic model", "advertorial model", "sentiment model"])
        return ArticleAnalysis(provider=provider, unavailable=unavailable)
    try:
        report("article_model", "Loading the article classification model.")
        zero_shot = load_zero_shot(settings.vital_zero_shot_model)
        article_text = _clip(f"{title}. {text}")
        report("health_topics", "Classifying article health topics.")
        topic_raw = zero_shot(
            article_text,
            candidate_labels=HEALTH_TOPICS,
            multi_label=True,
            hypothesis_template="This article is about {}.",
        )
        topics = [TopicResult(label=label, score=float(score)) for label, score in zip(topic_raw["labels"], topic_raw["scores"]) if score >= 0.20][:5]
        report("advertorial", "Classifying commercial-content signals.")
        advertorial_raw = zero_shot(
            article_text,
            candidate_labels=["Advertorial", "Non-Advertorial"],
            multi_label=False,
            hypothesis_template="This text is {}.",
        )
        advertorial = AdvertorialResult(label=advertorial_raw["labels"][0], score=float(advertorial_raw["scores"][0]))
    except Exception as exc:
        topics, advertorial = [], None
        unavailable.append(f"zero-shot models: {exc}")
    title_sentiment = content_sentiment = None
    framing = None
    try:
        report("sentiment", "Analysing headline and article sentiment.")
        sentiment = load_sentiment(settings.vital_sentiment_model)
        title_sentiment = _normalise_sentiment(sentiment(_clip(title, 100), truncation=True)[0])
        content_sentiment = _normalise_sentiment(sentiment(_clip(text, 384), truncation=True)[0])
        framing = _framing(title_sentiment, content_sentiment)
    except Exception as exc:
        unavailable.append(f"sentiment model: {exc}")
    return ArticleAnalysis(
        topics=topics,
        advertorial=advertorial,
        title_sentiment=title_sentiment,
        content_sentiment=content_sentiment,
        framing_difference=framing,
        provider=provider,
        unavailable=unavailable,
    )
