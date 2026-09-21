from app.article_analysis import analyse_article
from app.config import Settings
from app.schemas import AnalysisOptions


def test_disabled_sections_do_not_load_models(monkeypatch):
    def must_not_run(*args, **kwargs):
        raise AssertionError("Disabled model should never run")

    monkeypatch.setattr("app.article_analysis.load_zero_shot", must_not_run)
    monkeypatch.setattr("app.article_analysis.load_sentiment", must_not_run)
    monkeypatch.setattr("app.article_analysis.provider_lookup", must_not_run)
    result = analyse_article(
        "Headline",
        "An article with enough words.",
        None,
        Settings(vital_enable_ml=True),
        options=AnalysisOptions(
            topics=False, advertorial=False, sentiment=False, provider=False
        ),
    )
    assert result.topics == []
    assert result.advertorial is None
    assert result.content_sentiment is None
    assert result.provider is None


def test_topics_failure_does_not_hide_advertorial(monkeypatch):
    def fake_classifier(text, candidate_labels, **kwargs):
        if len(candidate_labels) > 2:
            raise RuntimeError("Topic classification failed")
        return {"labels": ["Non-Advertorial"], "scores": [0.8]}

    monkeypatch.setattr(
        "app.article_analysis.load_zero_shot", lambda *args: fake_classifier
    )
    monkeypatch.setattr("app.article_analysis.model_device", lambda _: "cpu")
    result = analyse_article(
        "Headline",
        "Article text.",
        None,
        Settings(vital_enable_ml=True),
        options=AnalysisOptions(sentiment=False, provider=False),
    )
    assert not result.topics
    assert result.advertorial.label == "Non-Advertorial"
