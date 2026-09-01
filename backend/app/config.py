from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    factiverse_api_key: str | None = None
    factiverse_claim_endpoint: str = "https://api.factiverse.ai/v1/claim_detection"
    factiverse_stance_endpoint: str = "https://api.factiverse.ai/v1/stance_detection"
    vital_demo_mode: bool = False
    vital_max_article_words: int = 800
    vital_max_claims: int = 5
    request_timeout_seconds: float = 90
    cache_ttl_seconds: int = 3600
    vital_enable_ml: bool = False
    vital_zero_shot_model: str = "MoritzLaurer/deberta-v3-large-zeroshot-v1"
    vital_sentiment_model: str = "distilbert/distilbert-base-uncased-finetuned-sst-2-english"
    vital_provider_csv: str = "data/providers.csv"

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


@lru_cache
def get_settings() -> Settings:
    return Settings()
