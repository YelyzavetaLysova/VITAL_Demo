"""Server-side client for the documented MediaFutures VITAL API."""

import asyncio
import hashlib
import json
from datetime import datetime
from urllib.parse import urlparse
from uuid import UUID

import httpx


class VitalApiError(RuntimeError):
    def __init__(self, message, code="upstream_error", status=None):
        super().__init__(message)
        self.code = code
        self.status = status


def response_error(status):
    messages = {
        401: (
            "VITAL rejected the API key. Check the backend configuration.",
            "authentication",
        ),
        403: (
            "This API key does not have access to the requested VITAL resource.",
            "permission",
        ),
        404: ("The VITAL analysis could not be found with this API key.", "not_found"),
        413: ("The article is larger than the VITAL request limit.", "article_size"),
        422: (
            "VITAL rejected the article metadata. Review its URL, language and publication date.",
            "metadata",
        ),
        429: (
            "VITAL's rate or analysis quota has been reached. Try again later.",
            "quota",
        ),
        502: (
            "The VITAL gateway could not reach an analysis service. Try again later.",
            "unavailable",
        ),
        503: (
            "The VITAL service is temporarily unavailable. Try again later.",
            "unavailable",
        ),
        504: (
            "The VITAL gateway timed out. The analysis may still be running.",
            "unavailable",
        ),
    }
    message, code = messages.get(
        status, (f"VITAL request failed (HTTP {status}).", "upstream_error")
    )
    return VitalApiError(
        message + f" (HTTP {status})" if status in messages else message, code, status
    )


def submission_payload(article, public_base="", selected_text=None, category=None):
    url = article.get("url", "")
    if not url:
        if public_base:
            url = f"{public_base.rstrip('/')}/article/{article['id']}"
        else:
            raise VitalApiError(
                "VITAL requires an article URL. Add its original URL or configure DEMO_PUBLIC_URL."
            )
    payload = {
        "title": article["title"],
        "content": selected_text or article["text"],
        "url": url,
        "language": article.get("language") or "en",
        "country": article.get("country") or "NO",
        "provider": article.get("publisher") or None,
        "category": category or article.get("theme") or "other",
    }
    timestamp = article.get("published_at", "")
    # Do not manufacture a publication time from a date-only value.
    if timestamp and "T" in timestamp:
        try:
            parsed = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
            if parsed.tzinfo:
                payload["published_at"] = parsed.isoformat()
        except ValueError:
            pass
    image = article.get("original_image_url") or article.get("image_url") or ""
    if image.startswith("/media/") and public_base:
        image = public_base.rstrip("/") + image
    payload["image_url"] = (
        image if urlparse(image).scheme in {"https", "http"} else None
    )
    return payload


class VitalClient:
    def __init__(self, api_base, api_key, version="frontend-1.0", transport=None):
        if not api_key:
            raise VitalApiError("VITAL_API_KEY is not configured.")
        self.base = api_base.rstrip("/")
        if urlparse(self.base).scheme != "https":
            raise VitalApiError("VITAL_API_BASE must use HTTPS.")
        self.headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "X-Vital-Client-Version": version,
        }
        self.transport = transport

    async def request(self, method, path, payload=None):
        async with httpx.AsyncClient(
            timeout=60, transport=self.transport, trust_env=False
        ) as client:
            try:
                response = await client.request(
                    method, self.base + path, headers=self.headers, json=payload
                )
            except httpx.HTTPError as exc:
                raise VitalApiError(
                    "The VITAL server could not be reached. Check the network connection.",
                    "connection",
                ) from exc
        if not response.is_success:
            raise response_error(response.status_code)
        try:
            data = response.json()
        except ValueError as exc:
            raise VitalApiError("VITAL returned an unreadable response.") from exc
        if not isinstance(data, dict):
            raise VitalApiError("VITAL returned an unexpected response format.")
        return data

    async def submit(self, payload):
        accepted = await self.request("POST", "/v1/analyses", payload)
        try:
            UUID(str(accepted["analysis_id"]))
        except (KeyError, ValueError, TypeError) as exc:
            raise VitalApiError("VITAL did not return a valid analysis_id.") from exc
        return accepted

    async def snapshot(self, analysis_id):
        try:
            identifier = str(UUID(str(analysis_id)))
        except (ValueError, TypeError) as exc:
            raise VitalApiError("Invalid VITAL analysis identifier.") from exc
        return await self.request("GET", f"/v1/analyses/{identifier}")

    async def events(self, analysis_id, after="0-0"):
        """Read authenticated SSE and resume with the server's Redis stream cursor."""
        identifier = str(UUID(str(analysis_id)))
        timeout = httpx.Timeout(40, connect=10, read=35, write=10, pool=10)
        async with httpx.AsyncClient(
            timeout=timeout, transport=self.transport, trust_env=False
        ) as client:
            try:
                async with client.stream(
                    "GET",
                    f"{self.base}/v1/analyses/{identifier}/events",
                    params={"after": after},
                    headers={**self.headers, "Accept": "text/event-stream"},
                ) as response:
                    if not response.is_success:
                        raise response_error(response.status_code)
                    if "text/event-stream" not in response.headers.get(
                        "content-type", ""
                    ):
                        raise VitalApiError(
                            "The event endpoint did not return an event stream.",
                            "event_stream",
                        )
                    cursor, event_name, lines = after, "", []
                    async for line in response.aiter_lines():
                        if not line:
                            if lines:
                                try:
                                    event = json.loads("\n".join(lines))
                                except ValueError as exc:
                                    raise VitalApiError(
                                        "VITAL returned an unreadable progress event.",
                                        "event_stream",
                                    ) from exc
                                if isinstance(event, dict):
                                    event.setdefault("event_type", event_name)
                                    yield cursor, event
                            event_name, lines = "", []
                        elif line.startswith("id:"):
                            cursor = line[3:].strip()
                        elif line.startswith("event:"):
                            event_name = line[6:].strip()
                        elif line.startswith("data:"):
                            lines.append(line[5:].lstrip())
            except httpx.HTTPError as exc:
                raise VitalApiError(
                    "The VITAL event connection was interrupted.", "event_stream"
                ) from exc


def result_status(snapshot):
    status = snapshot.get("status")
    if status is None and isinstance(snapshot.get("analysis"), dict):
        status = snapshot["analysis"].get("status")
    if status not in {"queued", "running", "complete", "partial", "failed"}:
        raise VitalApiError(
            "The VITAL response does not contain a documented analysis status."
        )
    return status


def result_data(snapshot):
    """Only consume structured values actually returned by the server.

    OpenAPI currently leaves the result object untyped. Accepted keys are kept
    explicit here and covered with fixtures; raw responses remain available to
    organizers so a real response can be used to refine this adapter.
    """
    for key in ("result", "cached_result", "results"):
        if isinstance(snapshot.get(key), dict):
            return snapshot[key]
    return snapshot


def normalise_claim(raw, index):
    if not isinstance(raw, dict):
        return None
    wording = raw.get("text") or raw.get("claim")
    if not isinstance(wording, str) or not wording.strip():
        return None
    status = raw.get("status") or raw.get("verdict") or "pending"
    aliases = {
        "supports": "supported",
        "support": "supported",
        "refutes": "contradicted",
        "contradicts": "contradicted",
        "not_enough_info": "insufficient",
        "not_enough_information": "insufficient",
        "processing": "checking",
        "failed": "error",
    }
    status = aliases.get(str(status).lower(), str(status).lower())
    known = {
        "pending",
        "skipped",
        "checking",
        "supported",
        "contradicted",
        "mixed",
        "insufficient",
        "context_needed",
        "error",
    }
    if status not in known:
        # An unrecognised server verdict is never turned into a false verdict.
        status = "pending"
    evidence = raw.get("evidence", [])
    if not isinstance(evidence, list):
        evidence = []
    source_records = []
    for item in evidence:
        if not isinstance(item, dict):
            continue
        source_records.append(
            {
                "title": item.get("title") or "Evidence source",
                "url": item.get("url"),
                "publisher": item.get("publisher"),
                "date": item.get("date"),
                "passage": item.get("passage")
                or item.get("snippet")
                or item.get("text"),
                "stance": item.get("stance") or "unknown",
            }
        )
    identifier = str(
        raw.get("id") or hashlib.sha256(f"{wording}:{index}".encode()).hexdigest()[:12]
    )
    explanation = raw.get("explanation") or raw.get("summary") or ""
    if not isinstance(explanation, str):
        explanation = ""
    return {
        "id": identifier,
        "text": wording,
        "status": status,
        "status_label": raw.get("status_label") or status,
        "explanation": explanation,
        "evidence": source_records,
        "summary": raw.get("summary"),
        "advanced_summary": raw.get("advanced_summary"),
        "suggested_fix": raw.get("suggested_fix"),
        "checked_at": raw.get("checked_at"),
        "theme": raw.get("theme"),
    }


def normalise_result(snapshot):
    data = result_data(snapshot)
    if "claim_result" in data:
        return normalise_vital_snapshot(data)
    claims = data.get("claims", [])
    claims = claims if isinstance(claims, list) else []
    normalized = [
        claim
        for index, raw in enumerate(claims)
        if (claim := normalise_claim(raw, index))
    ]
    article = data.get("article") or data.get("article_analysis") or {}
    article = dict(article) if isinstance(article, dict) else {}
    if isinstance(data.get("provider"), dict):
        article["provider"] = dict(data["provider"])
    warnings = data.get("warnings", [])
    warnings = [str(item) for item in warnings] if isinstance(warnings, list) else []
    if (
        not normalized
        and not article
        and data
        and not any(key in data for key in ("claims", "article", "article_analysis"))
        and snapshot.get("status") in {"complete", "partial"}
    ):
        warnings.append(
            "The server returned a result format this demo cannot display yet. The organizer can inspect the saved server response."
        )
    return normalized, article, warnings


def first_present(data, *keys):
    return next((data[key] for key in keys if data.get(key) is not None), None)


def verdict_status(value, label_map=None):
    if isinstance(label_map, dict):
        mapped = label_map.get(str(value))
        if isinstance(mapped, str):
            value = mapped
        else:
            for label, number in label_map.items():
                if number == value:
                    value = label
                    break
    # Numeric labels alone are not a documented verdict mapping.
    labels = {
        "SUPPORTS": "supported",
        "SUPPORTED": "supported",
        "REFUTES": "contradicted",
        "REFUTED": "contradicted",
        "CONTRADICTS": "contradicted",
        "CONTRADICTED": "contradicted",
        "MIXED": "mixed",
        "NEI": "insufficient",
        "NOT_ENOUGH_INFO": "insufficient",
        "NOT_ENOUGH_INFORMATION": "insufficient",
        "INSUFFICIENT": "insufficient",
        "CONTEXT_NEEDED": "context_needed",
    }
    return labels.get(str(value).strip().upper().replace(" ", "_"), "pending")


def factiverse_sources(response):
    sources = response.get("evidence") or response.get("sources") or []
    if isinstance(sources, dict):
        sources = list(sources.values())
    if not isinstance(sources, list):
        return []
    output = []
    for source in sources:
        if not isinstance(source, dict):
            continue
        stance = verdict_status(
            source.get(
                "labelDescription", source.get("predictedLabel", source.get("stance"))
            )
        )
        output.append(
            {
                "title": source.get("title") or source.get("name") or "Evidence source",
                "url": source.get("url") or source.get("link"),
                "publisher": source.get("domainName") or source.get("publisher"),
                "date": source.get("publishDate") or source.get("date"),
                "passage": source.get("evidenceSnippet")
                or source.get("snippet")
                or source.get("passage"),
                "stance": {"supported": "supports", "contradicted": "contradicts"}.get(
                    stance, stance if stance != "pending" else "unknown"
                ),
            }
        )
    return output


def api_reason(data):
    """Keep explicit API reasons verbatim; never invent a cause from an error code."""
    for field in ("reason", "explanation", "status_reason", "statusReason"):
        value = (data or {}).get(field)
        if isinstance(value, str) and value.strip():
            return value
    return None


def normalise_vital_snapshot(data):
    """Map the actual VITAL response observed during the live integration test."""
    result = data.get("claim_result") or {}
    detection = result.get("detectedClaims") or []
    classification = result.get("classification") or {}
    selections = {
        item.get("candidate_index"): item
        for item in classification.get("claims", [])
        if isinstance(item, dict)
    }
    stances = [
        item for item in result.get("stanceResults", []) if isinstance(item, dict)
    ]
    error_data = data.get("error") or {}
    errors = error_data.get("errors", []) if isinstance(error_data, dict) else []
    terminal = data.get("status") in {"complete", "partial", "failed"}
    normalized = []
    for index, detected in enumerate(detection):
        if not isinstance(detected, dict):
            continue
        raw = detected.get("raw") or {}
        text = detected.get("text") or raw.get("claim")
        if not isinstance(text, str) or not text:
            continue
        claim = normalise_claim({"text": text}, index)
        claim["candidate_index"] = index
        choice = selections.get(index, {})
        claim["theme"] = choice.get("category")
        claim["detection_score"] = detected.get("score")
        claim["checkworthiness"] = detected.get("checkworthiness_score")
        claim["verification_selected"] = choice.get("accepted")
        claim["scope_reason"] = choice.get("reason")
        if choice.get("accepted") is False:
            claim.update(
                status="skipped",
                explanation=choice.get("reason")
                or "The server did not provide a reason.",
            )
        else:
            stance = next(
                (
                    item
                    for item in stances
                    if item.get("candidateIndex") == index or item.get("claim") == text
                ),
                None,
            )
            failure = next(
                (
                    item
                    for item in errors
                    if isinstance(item, dict)
                    and not item.get("stage")
                    and (
                        item.get("candidateIndex") == index or item.get("claim") == text
                    )
                ),
                None,
            )
            if (stance and stance.get("errorType")) or failure:
                claim.update(
                    status="error",
                    explanation=api_reason(failure or stance)
                    or "The server did not provide a reason.",
                    api_error_type=(failure or stance).get("errorType"),
                )
            elif stance:
                response = stance.get("response") or stance.get("result") or stance
                status = verdict_status(
                    first_present(
                        response,
                        "finalLabelDescription",
                        "finalLabel",
                        "final_prediction_label",
                        "label",
                        "finalPrediction",
                        "prediction",
                    ),
                    response.get("labelMap"),
                )
                claim.update(
                    status=status,
                    summary=response.get("summary"),
                    advanced_summary=response.get("advancedSummary"),
                    suggested_fix=response.get("fix") or response.get("suggested_fix"),
                    evidence=factiverse_sources(response),
                    explanation=(
                        response.get("explanation")
                        if isinstance(response.get("explanation"), str)
                        else ""
                    ),
                )
            elif choice.get("accepted") is True and not terminal:
                claim.update(
                    status="checking",
                    explanation="VITAL selected this claim for evidence verification.",
                )
            else:
                claim["explanation"] = "No verification result or reason was provided."
        if claim["status"] == "pending":
            reason = api_reason(choice)
            if reason:
                claim["explanation"] = reason
        claim["status_label"] = claim["status"]
        normalized.append(claim)
    by_index = {claim.get("candidate_index"): claim for claim in normalized}
    classification_rows = []
    for item in classification.get("claims", []):
        match = by_index.get(item.get("candidate_index"))
        classification_rows.append(
            {
                **item,
                "claim_id": match["id"] if match else None,
                "text": match["text"] if match else None,
            }
        )
    article = {
        "category": data.get("article_category")
        or classification.get("article_category"),
        "claim_classification": classification_rows,
        "classification": classification,
        "main_topic": data.get("main_topic") or classification.get("main_topic"),
        "descriptive_topic": data.get("descriptive_topic")
        or classification.get("descriptive_topic"),
        "topic_reason": data.get("topic_reason") or classification.get("topic_reason"),
        "unavailable": [],
    }
    if isinstance(data.get("provider"), dict):
        article["provider"] = dict(data["provider"])
    unavailable = {
        "advertorial": "Commercial-content analysis is currently unavailable.",
        "transformation": "Article transformation is currently unavailable.",
    }
    for error in errors:
        if isinstance(error, dict) and error.get("stage"):
            message = unavailable.get(
                error["stage"], f"The {error['stage']} stage did not complete."
            )
            if message not in article["unavailable"]:
                article["unavailable"].append(message)
    advertorial = data.get("advertorial_result") or {}
    label = data.get("advertorial_label") or advertorial.get("label")
    if label is not None:
        article["advertorial"] = {
            **advertorial,
            "label": label,
            "score": (
                data.get("advertorial_confidence")
                if data.get("advertorial_confidence") is not None
                else first_present(advertorial, "confidence", "score")
            ),
        }
    transformation = data.get("transformation_result")
    if isinstance(transformation, dict):
        article["transformation"] = transformation
        for field in ("title_sentiment", "content_sentiment"):
            value = transformation.get(field)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                article[field] = {"score": value, "scale": "minus_one_to_one"}
            elif isinstance(value, dict):
                article[field] = value
        for field in (
            "word_count",
            "summary_generated",
            "entities_persons",
            "entities_organizations",
            "entities_locations",
            "entities_misc",
            "entities_medical",
            "n_medical_terms",
            "model_metadata",
        ):
            if transformation.get(field) is not None:
                article[field] = transformation[field]
    return normalized, article, []
