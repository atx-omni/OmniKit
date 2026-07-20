"""Sigma API client (mock transport) — mirrors the Metabase/Looker blocks in
`test_metabase_api.py`/`test_acquisition.py`. No live Sigma instance to verify against
(plan §6.4) — these tests only confirm the client speaks the *documented* shapes correctly."""

from __future__ import annotations

import httpx

from omni_migrator.extractors.sigma.api import SigmaApi, normalize_sigma_connection_type


def _handler(request: httpx.Request) -> httpx.Response:
    path = request.url.path
    if path == "/v2/auth/token":
        return httpx.Response(200, json={"access_token": "tok-1", "refresh_token": "refresh-1"})
    if path == "/v2/connections":
        return httpx.Response(200, json={"entries": [{"connectionId": "c1", "name": "Warehouse", "type": "bigQuery"}]})
    if path == "/v2/dataModels":
        return httpx.Response(200, json={"entries": [{"dataModelId": "dm1", "name": "Sales"}]})
    if path == "/v2/dataModels/dm1/spec":
        return httpx.Response(200, json={"dataModelId": "dm1", "pages": []})
    if path == "/v2/workbooks":
        return httpx.Response(200, json={"entries": [{"workbookId": "wb1", "name": "Ops"}]})
    if path == "/v2/workbooks/wb1/pages":
        return httpx.Response(200, json={"entries": [{"pageId": "p1", "name": "Overview", "hidden": False}]})
    if path == "/v2/workbooks/wb1/pages/p1/elements":
        return httpx.Response(200, json={"entries": [{"elementId": "e1", "name": "Revenue"}]})
    return httpx.Response(404)


def _api(**kwargs) -> SigmaApi:
    return SigmaApi(
        base_url="https://aws-api.sigmacomputing.com", client_id="cid", client_secret="secret",
        transport=httpx.MockTransport(_handler), **kwargs,
    )


def test_login_sets_bearer_header_and_stores_refresh_token():
    api = _api()
    assert api.login() == "tok-1"
    assert api._http.headers["Authorization"] == "Bearer tok-1"
    assert api._refresh_token == "refresh-1"


def test_normalize_sigma_connection_type_unknown_falls_back_to_other():
    assert normalize_sigma_connection_type("some-future-type") == "other"
    assert normalize_sigma_connection_type(None) == "other"


def test_normalize_sigma_connection_type_confirmed_bigquery():
    assert normalize_sigma_connection_type("bigQuery") == "bigquery"


def test_list_connections():
    api = _api()
    conns = api.list_connections()
    assert conns[0]["type"] == "bigQuery"


def test_data_model_spec():
    api = _api()
    spec = api.data_model_spec("dm1")
    assert spec["dataModelId"] == "dm1"


def test_workbook_pages_and_elements():
    api = _api()
    pages = api.workbook_pages("wb1")
    assert pages[0]["name"] == "Overview"
    elements = api.workbook_page_elements("wb1", "p1")
    assert elements[0]["name"] == "Revenue"


def test_snapshot_assembles_all_endpoints():
    api = _api()
    snap = api.snapshot()
    assert snap["connections"][0]["connectionId"] == "c1"
    (dm,) = snap["dataModels"]
    assert dm["dataModelId"] == "dm1" and dm["spec"]["dataModelId"] == "dm1"
    (wb,) = snap["workbooks"]
    assert wb["workbookId"] == "wb1"
    (page,) = wb["pages"]
    assert page["elements"][0]["name"] == "Revenue"


def test_token_refresh_on_401_then_retries():
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v2/auth/token":
            if request.content and b"refresh_token" in request.content:
                return httpx.Response(200, json={"access_token": "tok-2", "refresh_token": "refresh-2"})
            return httpx.Response(200, json={"access_token": "tok-1", "refresh_token": "refresh-1"})
        if request.url.path == "/v2/connections":
            calls["n"] += 1
            if request.headers.get("Authorization") == "Bearer tok-1":
                return httpx.Response(401)
            return httpx.Response(200, json={"entries": []})
        return httpx.Response(404)

    api = SigmaApi(
        base_url="https://aws-api.sigmacomputing.com", client_id="cid", client_secret="secret",
        transport=httpx.MockTransport(handler),
    )
    api.list_connections()
    assert calls["n"] == 2  # first 401 with the stale token, then a retry that succeeds
    assert api._http.headers["Authorization"] == "Bearer tok-2"
