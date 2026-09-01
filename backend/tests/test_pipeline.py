from app.pipeline import assessment, claim_text, is_probably_health_claim, normalise_evidence, offsets
from app.article_analysis import provider_lookup


def test_health_filter():
    assert is_probably_health_claim("Coffee reduces the risk of heart disease")[0]
    assert not is_probably_health_claim("The parliament passed the bill on Tuesday")[0]


def test_claim_variants():
    assert claim_text({"claim": "A claim"}) == "A claim"
    assert claim_text({"sentence": "Another claim"}) == "Another claim"


def test_offsets():
    assert offsets("Before Coffee improves health. After", "Coffee improves health.") == (7, 30)


def test_stance_normalisation():
    evidence = normalise_evidence({"evidence": [{"title": "Study", "stance": "supports", "snippet": "Result"}]})
    assert evidence[0].stance == "supports"
    assert assessment({"finalPrediction": "supported"}, evidence)[0] == "supported"


def test_real_factiverse_support_response():
    raw = {
        "finalScore": 0.7007,
        "finalPrediction": 1,
        "finalLabelDescription": "SUPPORTS",
        "labelMap": {
            "REFUTES": 0,
            "SUPPORTS": 1,
            "MIXED": 2,
            "NOT_ENOUGH_INFO": 3,
        },
        "evidence": [
            {
                "title": "Medical source",
                "url": "https://example.org/evidence",
                "domainName": "example",
                "evidenceSnippet": "The result supports the claim.",
                "publishDate": "2026-01-01 00:00:00",
                "stanceScore": 0.90625,
                "labelDescription": "SUPPORTS",
                "predictedLabel": 1,
                "simScore": 0.99,
                "exactMatch": True,
                "citationCount": 12,
                "domain_reliability": {
                    "Reliability": "Known",
                    "bias_data": {
                        "bias": "Pro-Science",
                        "source_url": "https://example.org/bias",
                    },
                    "reuters_trust_score": {
                        "score": 58,
                        "source": "https://example.org/trust",
                    },
                },
            }
        ],
    }

    evidence = normalise_evidence(raw)

    assert evidence[0].stance == "supports"
    assert evidence[0].stance_score == 0.90625
    assert evidence[0].reliability == "Known"
    assert evidence[0].bias == "Pro-Science"
    assert evidence[0].trust_score == 58
    assert assessment(raw, evidence)[0] == "supported"


def test_factiverse_mixed_and_insufficient_evidence_labels():
    mixed = normalise_evidence(
        {"evidence": [{"title": "Study", "labelDescription": "MIXED"}]}
    )
    insufficient = normalise_evidence(
        {
            "evidence": [
                {
                    "title": "Study",
                    "labelDescription": "NOT_ENOUGH_INFO",
                }
            ]
        }
    )

    assert mixed[0].stance == "mixed"
    assert insufficient[0].stance == "insufficient"


def test_provider_lookup(tmp_path):
    metadata = tmp_path / "providers.csv"
    metadata.write_text("domain,name,credibility,bias,country\ncnn.com,CNN,high,left-center,US\n")
    result = provider_lookup("https://edition.cnn.com/health/story", str(metadata))
    assert result and result.name == "CNN" and result.credibility == "high"
