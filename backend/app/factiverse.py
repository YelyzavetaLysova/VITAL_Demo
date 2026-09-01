import asyncio
from typing import Any

import httpx

from .config import Settings


TRANSIENT = {429, 500, 502, 503, 504}


class FactiverseError(RuntimeError):
    pass


class FactiverseClient:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.headers = {
            "Authorization": f"Bearer {settings.factiverse_api_key}",
            "Content-Type": "application/json",
        }

    async def _post(self, endpoint: str, payload: dict[str, Any]) -> dict[str, Any]:
        last_error = "Unknown API failure"
        async with httpx.AsyncClient(timeout=self.settings.request_timeout_seconds) as client:
            for attempt in range(3):
                try:
                    response = await client.post(endpoint, headers=self.headers, json=payload)
                    if response.status_code in TRANSIENT and attempt < 2:
                        await asyncio.sleep(2**attempt)
                        continue
                    response.raise_for_status()
                    data = response.json()
                    return data if isinstance(data, dict) else {"data": data}
                except (httpx.HTTPError, ValueError) as exc:
                    last_error = str(exc)
                    if attempt < 2:
                        await asyncio.sleep(2**attempt)
        raise FactiverseError(last_error)

    async def detect_claims(self, text: str, language: str) -> list[dict[str, Any]]:
        raw = await self._post(
            self.settings.factiverse_claim_endpoint,
            {"text": text, "language": language},
        )
        if isinstance(raw.get("detectedClaims"), list):
            return raw["detectedClaims"]
        claims: list[dict[str, Any]] = []
        for item in raw.get("data", []):
            if isinstance(item, dict) and isinstance(item.get("detectedClaims"), list):
                claims.extend(item["detectedClaims"])
        return claims

    async def check_stance(self, claim: str, language: str) -> dict[str, Any]:
        return await self._post(
            self.settings.factiverse_stance_endpoint,
            {"claim": claim, "lang": language},
        )
