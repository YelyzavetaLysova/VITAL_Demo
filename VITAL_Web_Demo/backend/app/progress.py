"""Project actual coordinator events into the same schema as a final snapshot."""

from .vital_api import normalise_result


class CoordinatorProgress:
    def __init__(self):
        self.candidates = {}
        self.stances = {}
        self.classification = {}
        self.advertorial = None
        self.transformation = {}
        self.errors = []
        self.total = None
        self.chunks = {}
        self.message = "Waiting for analysis to start."
        self.stage = "queued"

    def consume(self, event):
        kind, payload = event.get("event_type", ""), event.get("payload") or {}
        if kind == "heartbeat":
            return None
        self.stage = kind
        if kind == "analysis.queued":
            self.message = "Waiting in the server queue."
        elif kind == "analysis.started":
            self.message = "Finding claims."
        elif kind == "claims.partitioned":
            self.message = (
                f"Finding claims in {payload.get('chunkCount', 1)} article sections."
            )
        elif kind == "claims.chunk.completed":
            self.chunks[payload.get("chunkIndex", 0)] = payload.get("claimCount", 0)
            # Current coordinator events carry counts, not claim wording.
            # Newer servers may include candidates, which can also be displayed.
            self.message = f"Found {sum(self.chunks.values())} claims so far."
        elif kind == "claims.extracted":
            self.total = payload.get("claimCount")
            for index, claim in enumerate(payload.get("claims", [])):
                if isinstance(claim, dict) and isinstance(claim.get("text"), str):
                    self.candidates[index] = claim
            self.message = f"Found {self.total} claims. Classifying them."
        elif kind == "claims.classified":
            self.classification = {
                "claims": payload.get("decisions", []),
                "article_category": payload.get("articleCategory"),
                "main_topic": payload.get("mainTopic"),
                "descriptive_topic": payload.get("descriptiveTopic"),
                "topic_reason": payload.get("topicReason"),
            }
            self.message = f"Checking {payload.get('accepted', 0)} selected claims."
        elif kind in {"stance.completed", "stance.failed"}:
            index = payload.get("candidateIndex")
            if isinstance(index, int) and isinstance(payload.get("claim"), str):
                self.candidates[index] = {"text": payload["claim"]}
                self.stances[index] = payload
            self.message = f"Checked {len(self.stances)} claims."
        elif kind == "advertorial.completed":
            self.advertorial = payload.get("result")
            self.message = "Commercial-content result received."
        elif kind == "transformation.completed":
            if isinstance(payload.get("result"), dict):
                self.transformation.update(payload["result"])
            self.transformation.update(
                {
                    "word_count": payload.get("wordCount"),
                    "title_sentiment": payload.get("titleSentiment"),
                    "content_sentiment": payload.get("contentSentiment"),
                }
            )
            self.message = "Article details received."
        elif kind.endswith(".failed"):
            stage = {
                "claims.classification.failed": "classification",
                "advertorial.failed": "advertorial",
                "transformation.failed": "transformation",
            }.get(kind)
            if stage:
                self.errors.append(
                    {"stage": stage, "errorType": payload.get("errorType")}
                )
            self.message = "One analysis stage could not finish."
        elif kind in {"analysis.complete", "analysis.partial"}:
            self.message = "Retrieving final results."
        elif kind == "analysis.failed":
            self.message = "The server reported a failed analysis."
        count = max(self.candidates, default=-1) + 1
        detected = [self.candidates.get(index, {"text": ""}) for index in range(count)]
        snapshot = {
            "status": "running",
            "claim_result": {
                "detectedClaims": detected,
                "classification": self.classification,
                "stanceResults": list(self.stances.values()),
            },
            "advertorial_result": self.advertorial,
            "transformation_result": self.transformation,
            "error": {"errors": self.errors},
        }
        claims, article, warnings = normalise_result(snapshot)
        return {
            "claims": claims,
            "article": article,
            "message": self.message,
            "stage": self.stage,
            "detected_count": (
                self.total if self.total is not None else sum(self.chunks.values())
            ),
            "checked_count": len(self.stances),
        }
