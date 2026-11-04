from app.vital_api import normalise_result
from app.progress import CoordinatorProgress

HISTORY = {'status':'available', 'medical_term': {'status':'available','name':'Mental Health','support_percent':59.93,'overall_support_percent':54.67,'difference_percentage_points':5.26}}

def test_snapshot_historical():
    claims, article, _ = normalise_result({'status':'complete','claim_result':{},'historical_insights':HISTORY})
    assert article['historical_insights'] == HISTORY

def test_event_historical():
    progress = CoordinatorProgress()
    result = progress.consume({'event_type':'historical_insights.completed','payload':{'result':HISTORY}})
    assert result['article']['historical_insights'] == HISTORY
    result = progress.consume({'event_type':'analysis.complete','payload':{}})
    assert result['article']['historical_insights'] == HISTORY

def test_unavailable_event():
    result = CoordinatorProgress().consume({'event_type':'historical_insights.failed','payload':{}})
    assert result['article']['historical_insights']['status'] == 'unavailable'
