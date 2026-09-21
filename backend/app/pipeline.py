import hashlib
import re
from collections.abc import Awaitable, Callable
from typing import Any

from .config import Settings
from .factiverse import FactiverseClient, FactiverseError
from .schemas import AnalyseRequest, ClaimResult, EvidenceItem

HEALTH_TERMS = {
    "health",
    "healthy",
    "disease",
    "risk",
    "cancer",
    "heart",
    "blood",
    "brain",
    "diet",
    "food",
    "nutrition",
    "vitamin",
    "weight",
    "sleep",
    "exercise",
    "drug",
    "medicine",
    "medical",
    "treatment",
    "symptom",
    "patient",
    "doctor",
    "mortality",
    "infection",
    "vaccine",
    "mental",
    "anxiety",
    "depression",
    "pain",
    "coffee",
}


def compact_text(text: str, max_words: int) -> str:
    return " ".join(text.split()[:max_words])


def claim_text(item: Any) -> str:
    if isinstance(item, str):
        return item.strip()

    if isinstance(item, dict):
        return str(
            item.get("claim")
            or item.get("text")
            or item.get("sentence")
            or item.get("span")
            or ""
        ).strip()

    return ""


def is_probably_health_claim(text: str) -> tuple[bool, float]:
    words = set(re.findall(r"[a-z]+", text.lower()))
    matches = words & HEALTH_TERMS

    score = min(
        0.95,
        0.45 + len(matches) * 0.13,
    )

    return (
        bool(matches),
        score if matches else 0.15,
    )


ProgressCallback = Callable[[str, str, int, int | None], Awaitable[None]]


async def report_progress(
    callback: ProgressCallback | None,
    phase: str,
    message: str,
    completed_claims: int = 0,
    total_claims: int | None = None,
) -> None:
    if callback is not None:
        await callback(
            phase,
            message,
            completed_claims,
            total_claims,
        )


def offsets(
    article: str,
    claim: str,
) -> tuple[int | None, int | None]:
    start = article.lower().find(claim.lower())

    if start >= 0:
        return start, start + len(claim)

    normalised_claim = " ".join(claim.split())
    normalised_article = " ".join(article.split())

    match = re.search(
        re.escape(normalised_claim),
        normalised_article,
        re.IGNORECASE,
    )

    if match:
        return match.start(), match.end()

    return None, None


def first_value(
    data: dict[str, Any],
    *keys: str,
) -> Any:
    for key in keys:
        if data.get(key) is not None:
            return data[key]

    return None


def normalise_stance(value: Any) -> str:
    """
    Convert Factiverse labels and numeric predictions into
    the internal VITAL stance names.

    Factiverse label map:

        REFUTES = 0
        SUPPORTS = 1
        MIXED = 2
        NOT_ENOUGH_INFO = 3
    """

    if isinstance(value, (int, float)):
        numeric_value = int(value)

        numeric_labels = {
            0: "contradicts",
            1: "supports",
            2: "mixed",
            3: "insufficient",
        }

        if numeric_value in numeric_labels:
            return numeric_labels[numeric_value]

    text = str(value or "").strip().lower()

    numeric_text_labels = {
        "0": "contradicts",
        "1": "supports",
        "2": "mixed",
        "3": "insufficient",
    }

    if text in numeric_text_labels:
        return numeric_text_labels[text]

    if any(
        phrase in text
        for phrase in (
            "not_enough_info",
            "not enough info",
            "not enough evidence",
            "insufficient",
            "unknown",
        )
    ):
        return "insufficient"

    if "mixed" in text:
        return "mixed"

    if any(
        word in text
        for word in (
            "support",
            "entail",
            "agree",
            "true",
        )
    ):
        return "supports"

    if any(
        word in text
        for word in (
            "contradict",
            "refute",
            "disagree",
            "false",
        )
    ):
        return "contradicts"

    if any(
        word in text
        for word in (
            "qualif",
            "context",
            "partly",
        )
    ):
        return "qualifies"

    if "mention" in text:
        return "mentions"

    return "unknown"


def factiverse_final_label(raw: dict[str, Any]) -> Any:
    """
    Prefer Factiverse's human-readable final label.

    The API returns both:

        finalPrediction: 1
        finalLabelDescription: "SUPPORTS"

    The previous implementation read the numeric prediction first
    and consequently failed to recognise it.
    """

    label = first_value(
        raw,
        "finalLabelDescription",
        "final_label_description",
        "finalLabel",
        "labelDescription",
        "prediction",
        "label",
    )

    if label is not None:
        return label

    prediction = first_value(
        raw,
        "finalPrediction",
        "final_prediction",
    )

    label_map = raw.get("labelMap")

    if prediction is not None and isinstance(label_map, dict):
        for label_name, label_value in label_map.items():
            if label_value == prediction:
                return label_name

    return prediction


def evidence_description(raw: dict[str, Any]) -> str:
    """
    Extract an explanation without using the short verdict label
    itself as the explanation.
    """

    description = first_value(
        raw,
        "summary",
        "advancedSummary",
        "explanation",
        "fix",
    )

    if description is None:
        return ""

    if isinstance(description, str):
        return description.strip()

    if isinstance(description, list):
        return "\n\n".join(
            evidence_description({"summary": item})
            for item in description
            if item is not None
        ).strip()
    if isinstance(description, dict):
        return str(
            first_value(description, "text", "summary", "explanation", "description")
            or ""
        ).strip()
    return str(description).strip()


def normalise_evidence(
    raw: dict[str, Any],
) -> list[EvidenceItem]:
    items = (
        first_value(
            raw,
            "evidence",
            "sources",
            "results",
            "documents",
        )
        or []
    )

    if isinstance(items, dict):
        items = list(items.values())

    if not isinstance(items, list):
        return []

    output: list[EvidenceItem] = []

    for item in items[:10]:
        if not isinstance(item, dict):
            continue

        stance_value = first_value(
            item,
            "labelDescription",
            "detailedLabelDescription",
            "stance",
            "prediction",
            "label",
            "predictedLabel",
        )

        output.append(
            EvidenceItem(
                title=str(
                    first_value(
                        item,
                        "title",
                        "name",
                        "sourceTitle",
                    )
                    or "Evidence source"
                ),
                publisher=first_value(
                    item,
                    "domainName",
                    "publisher",
                    "source",
                    "domain",
                ),
                url=first_value(
                    item,
                    "url",
                    "link",
                    "sourceUrl",
                ),
                date=(
                    str(
                        first_value(
                            item,
                            "publishDate",
                            "publishedDate",
                            "published_at",
                            "date",
                        )
                        or ""
                    )
                    or None
                ),
                passage=first_value(
                    item,
                    "evidenceSnippet",
                    "snippet",
                    "passage",
                    "text",
                    "summary",
                ),
                stance=normalise_stance(stance_value),
                source_type=first_value(
                    item,
                    "sourceType",
                    "type",
                    "searchEngine",
                ),
                stance_score=first_value(item, "stanceScore"),
                similarity_score=first_value(item, "simScore"),
                exact_match=first_value(item, "exactMatch"),
                citation_count=first_value(item, "citationCount"),
                language=first_value(item, "lang", "language"),
                authors=item.get("authors") or [],
                keywords=item.get("keywords") or [],
                preferred_site=first_value(item, "preferred_site", "preferredSite"),
                original_query=first_value(item, "original_query", "originalQuery"),
                translated=first_value(item, "translated"),
                translated_query=first_value(
                    item, "translated_query", "translatedQuery"
                ),
                rewritten_query=first_value(item, "rewritten_query", "rewrittenQuery"),
                predicted_label=first_value(item, "predictedLabel"),
                softmax_score=item.get("softmaxScore") or [],
                detailed_label=first_value(item, "detailedLabelDescription"),
                reliability=(item.get("domain_reliability") or {}).get("Reliability"),
                bias=(
                    (item.get("domain_reliability") or {}).get("bias_data") or {}
                ).get("bias"),
                bias_source_url=(
                    (item.get("domain_reliability") or {}).get("bias_data") or {}
                ).get("source_url"),
                trust_score=(
                    (item.get("domain_reliability") or {}).get("reuters_trust_score")
                    or {}
                ).get("score"),
                trust_score_source=(
                    (item.get("domain_reliability") or {}).get("reuters_trust_score")
                    or {}
                ).get("source"),
                factiverse=item,
            )
        )

    return output


def assessment(
    raw: dict[str, Any],
    evidence: list[EvidenceItem],
) -> tuple[str, str, str]:
    """
    Convert Factiverse's final assessment to a VITAL status.

    Factiverse's final verdict is authoritative. Individual evidence
    results are used only if no final verdict was returned.
    """

    final_label = factiverse_final_label(raw)
    final_stance = normalise_stance(final_label)
    description = evidence_description(raw)

    if final_stance == "supports":
        return (
            "supported",
            "Supported",
            description
            or (
                "Factiverse found that the retrieved evidence "
                "generally supports this claim."
            ),
        )

    if final_stance == "contradicts":
        return (
            "contradicted",
            "Contradicted",
            description
            or (
                "Factiverse found that the retrieved evidence "
                "generally refutes this claim."
            ),
        )

    if final_stance == "mixed":
        return (
            "mixed",
            "Mixed evidence",
            description
            or (
                "Factiverse found a mixture of supporting and "
                "refuting evidence for this claim."
            ),
        )

    if final_stance == "qualifies":
        return (
            "context_needed",
            "Context needed",
            description
            or (
                "The claim requires qualifications or additional "
                "context found in the evidence."
            ),
        )

    if final_stance == "insufficient":
        return (
            "insufficient",
            "Insufficient evidence",
            description
            or (
                "Factiverse did not find enough evidence to "
                "determine whether this claim is supported or refuted."
            ),
        )

    # Fallback used only when Factiverse did not return a final verdict.
    evidence_stances = {item.stance for item in evidence if item.stance != "unknown"}

    if "supports" in evidence_stances and "contradicts" in evidence_stances:
        return (
            "mixed",
            "Mixed evidence",
            description
            or ("The retrieved sources do not consistently agree " "about this claim."),
        )

    if "supports" in evidence_stances:
        return (
            "supported",
            "Supported",
            description or ("The retrieved evidence generally supports " "this claim."),
        )

    if "contradicts" in evidence_stances:
        return (
            "contradicted",
            "Contradicted",
            description or ("The retrieved evidence generally refutes " "this claim."),
        )

    if "qualifies" in evidence_stances:
        return (
            "context_needed",
            "Context needed",
            description
            or (
                "The retrieved evidence indicates that the claim "
                "requires additional context."
            ),
        )

    return (
        "insufficient",
        "Insufficient evidence",
        description
        or ("VITAL could not find enough aligned evidence " "to assess this claim."),
    )


def demo_claims(
    request: AnalyseRequest,
) -> list[dict[str, Any]]:
    source = request.selected_text or request.text

    sentences = re.split(
        r"(?<=[.!?])\s+",
        source,
    )

    candidates = [
        sentence.strip()
        for sentence in sentences
        if (len(sentence.split()) >= 7 and is_probably_health_claim(sentence)[0])
    ]

    if not candidates and request.selected_text:
        candidates = [request.selected_text.strip()]

    return [
        {
            "claim": sentence,
            "score": 0.82,
            "checkworthiness_score": 3,
        }
        for sentence in candidates[:5]
    ]


async def analyse(
    request: AnalyseRequest,
    settings: Settings,
    progress: ProgressCallback | None = None,
) -> tuple[list[ClaimResult], list[str], str]:
    article = compact_text(
        request.text,
        settings.vital_max_article_words,
    )

    warnings: list[str] = []

    live = bool(settings.factiverse_api_key) and not settings.vital_demo_mode

    client = FactiverseClient(settings) if live else None

    if request.selected_text:
        await report_progress(
            progress,
            "claim_detection",
            "Using the selected text as the claim.",
        )
        detected = [
            {
                "claim": request.selected_text,
                "score": 1.0,
                "checkworthiness_score": 5,
            }
        ]

    elif live:
        try:
            await report_progress(
                progress,
                "claim_detection",
                "Detecting checkable claims with Factiverse.",
            )
            detected = await client.detect_claims(
                article,
                request.language,
            )
        except FactiverseError as exc:
            detected = demo_claims(request)
            live = False

            warnings.append("Claim service unavailable; " f"local fallback used: {exc}")

    else:
        detected = demo_claims(request)

        warnings.append(
            "Demo mode: configure FACTIVERSE_API_KEY "
            "for live claim and evidence analysis."
        )

    results: list[ClaimResult] = []
    candidate_claims = [item for item in detected if claim_text(item)][
        : settings.vital_max_claims
    ]
    total_claims = len(candidate_claims)

    for index, raw_claim in enumerate(candidate_claims):
        text = claim_text(raw_claim)

        if not text:
            continue

        stance_raw: dict[str, Any] = {}

        if live:
            try:
                await report_progress(
                    progress,
                    "evidence",
                    f"Retrieving and assessing evidence for claim {index + 1} of {total_claims}.",
                    index,
                    total_claims,
                )
                stance_raw = await client.check_stance(
                    text,
                    request.language,
                )
            except FactiverseError as exc:
                warnings.append(
                    "Evidence lookup failed for " f"claim {index + 1}: {exc}"
                )

        evidence = normalise_evidence(stance_raw)

        status, label, explanation = assessment(
            stance_raw,
            evidence,
        )

        start, end = offsets(
            request.text,
            text,
        )

        identifier = hashlib.sha256(f"{text}:{index}".encode()).hexdigest()[:12]

        raw_prediction_value = factiverse_final_label(stance_raw)

        results.append(
            ClaimResult(
                id=identifier,
                text=text,
                start=start,
                end=end,
                detection_score=first_value(
                    raw_claim,
                    "score",
                    "confidence",
                ),
                checkworthiness=first_value(
                    raw_claim,
                    "checkworthiness_score",
                    "checkworthiness",
                ),
                status=status,
                status_label=label,
                explanation=explanation,
                evidence=evidence,
                raw_prediction=(
                    str(raw_prediction_value)
                    if raw_prediction_value is not None
                    else None
                ),
                final_score=first_value(stance_raw, "finalScore", "final_score"),
                final_label=(
                    str(raw_prediction_value)
                    if raw_prediction_value is not None
                    else None
                ),
                resolved_claim=first_value(stance_raw, "resolvedClaim"),
                summary=first_value(stance_raw, "summary"),
                advanced_summary=first_value(stance_raw, "advancedSummary"),
                suggested_fix=first_value(stance_raw, "fix"),
                label_map=stance_raw.get("labelMap") or {},
                factiverse=stance_raw,
            )
        )

        await report_progress(
            progress,
            "evidence",
            f"Completed evidence assessment for claim {index + 1} of {total_claims}.",
            index + 1,
            total_claims,
        )

        if len(results) >= settings.vital_max_claims:
            break

    return (
        results,
        list(dict.fromkeys(warnings)),
        "live" if live else "demo",
    )
