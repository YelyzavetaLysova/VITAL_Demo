import asyncio
import copy
import importlib
import json
import os
import tempfile
from uuid import uuid4

import httpx
import pytest
from app.vital_api import VitalClient, VitalApiError, normalise_result, manual_assessment_updates

ID = str(uuid4())

def snapshot():
    return {'id': ID, 'status': 'complete', 'claim_result': {
        'detectedClaims': [{'text': 'Stored candidate'}, {'text': 'Automatic candidate'}],
        'classification': {'claims': [
            {'candidate_index': 0, 'accepted': False, 'category': 'non-health', 'reason': 'Original rejection'},
            {'candidate_index': 1, 'accepted': False, 'category': 'non-health'}]},
        'stanceResults': [{'candidateIndex': 1, 'result': {'label': 'supports'}}]}}


def test_eligibility_and_original_decision():
    claims, _, _ = normalise_result(snapshot())
    assert claims[0]['can_analyze_manually'] is True
    assert claims[0]['model_reason'] == 'Original rejection'
    assert claims[1]['can_analyze_manually'] is False


def test_http_contract_no_claim_text_and_safe_status_origin():
    calls = []
    def handler(request):
        calls.append(request)
        if request.method == 'POST':
            return httpx.Response(202, json={'analysis_id': ID, 'candidate_index': 0, 'status': 'queued'})
        return httpx.Response(200, json=[])
    async def run():
        client = VitalClient('https://api.example.com', 'test', transport=httpx.MockTransport(handler))
        await client.create_claim_assessment(ID, 0)
        assert calls[-1].content == b''
        assert calls[-1].url.path == f'/v1/analyses/{ID}/claims/0/assessments'
        assert await client.list_claim_assessments(ID) == []
        with pytest.raises(VitalApiError):
            await client.claim_assessment('https://other.example.com/secret')
    asyncio.run(run())


def test_verdict_keeps_rejection():
    result = manual_assessment_updates({'status': 'complete', 'model_accepted': False,
        'model_category': 'non-health', 'model_reason': 'Original rejection',
        'result': {'finalLabelDescription': 'supports', 'summary': 'Evidence summary'}})
    assert result['status'] == 'supported'
    assert result['model_accepted'] is False
    assert result['model_reason'] == 'Original rejection'
    assert result['manual_origin'] == 'user_requested'


def test_backend_resume_duplicate_and_coverage(monkeypatch):
    with tempfile.TemporaryDirectory() as directory:
        monkeypatch.setenv('DEMO_ADMIN_PASSWORD', 'test-only')
        monkeypatch.setenv('DEMO_DATABASE', directory + '/demo.sqlite3')
        module = importlib.import_module('app.demo_main')
        claims, _, _ = normalise_result(snapshot())
        coverage = {'assessed_claims': 1, 'submitted_claims': 2, 'coverage_percent': 50}
        analysis = {'analysis_id': 'local', 'remote_analysis_id': ID, 'phase': 'completed',
            'claims': claims, 'assessment_coverage': copy.deepcopy(coverage), 'server_response': snapshot()}
        record = {'analysis': analysis}
        class Store:
            def get(self, identifier): return copy.deepcopy(record)
        monkeypatch.setattr(module, 'store', Store())
        def modify(identifier, fn): record['analysis'] = fn(record['analysis'])
        monkeypatch.setattr(module, 'modify', modify)
        assessment = {'assessment_id': str(uuid4()), 'analysis_id': ID, 'candidate_index': 0,
            'status': 'queued', 'status_url': '/manual/status', 'model_accepted': False,
            'model_reason': 'Original rejection', 'model_category': 'non-health'}
        class Client:
            creates = 0
            gets = 0
            async def list_claim_assessments(self, remote): return []
            async def create_claim_assessment(self, remote, index):
                self.creates += 1
                # A simultaneous repeat sees checking and must not create another request.
                await module.verify_claim('article', claims[0]['id'])
                return dict(assessment)
            async def claim_assessment(self, url):
                self.gets += 1
                return {**assessment, 'status': 'complete', 'result': {'label': 'supports'}}
        client = Client()
        monkeypatch.setattr(module, 'vital_client', lambda: client)
        monkeypatch.setattr(module.config, 'vital_poll_interval_seconds', 0)
        asyncio.run(module.verify_claim('article', claims[0]['id']))
        assert client.creates == 1
        assert record['analysis']['claims'][0]['status'] == 'supported'
        assert record['analysis']['assessment_coverage'] == coverage
        asyncio.run(module.verify_claim('article', claims[0]['id']))
        assert client.creates == 1
        # Resume a persisted queued assessment without a new POST.
        record['analysis']['claims'][0].update(status='error', can_analyze_manually=True,
            manual_status='queued', manual_assessment=assessment)
        asyncio.run(module.verify_claim('article', claims[0]['id']))
        assert client.creates == 1 and client.gets == 2
