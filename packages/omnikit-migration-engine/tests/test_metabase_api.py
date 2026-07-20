"""Metabase API client (mock transport) — mirrors the Looker block in `test_acquisition.py`."""

from __future__ import annotations

import httpx

from omni_migrator.extractors.metabase.api import MetabaseApi, normalize_metabase_engine


def _handler(request: httpx.Request) -> httpx.Response:
    path = request.url.path
    if path == "/api/session":
        return httpx.Response(200, json={"id": "sess-tok"})
    if path == "/api/database":
        return httpx.Response(200, json=[
            {"id": 1, "name": "Warehouse", "engine": "postgres"},
            {"id": 2, "name": "Legacy", "engine": "sparksql"},
        ])
    if path == "/api/table":
        return httpx.Response(200, json=[{"id": 100, "db_id": 1, "name": "orders", "schema": "public"}])
    if path == "/api/table/100/query_metadata":
        return httpx.Response(200, json={
            "id": 100, "name": "orders",
            "fields": [{"id": 10, "name": "id", "base_type": "type/BigInteger", "semantic_type": "type/PK"}],
        })
    if path == "/api/segment":
        return httpx.Response(200, json=[])
    if path == "/api/card":
        return httpx.Response(200, json=[{"id": 1, "type": "question", "name": "Q1"}])
    if path == "/api/dashboard":
        return httpx.Response(200, json=[{"id": 1, "name": "Ops"}])
    if path == "/api/dashboard/1":
        return httpx.Response(200, json={"id": 1, "name": "Ops", "dashcards": []})
    if path == "/api/collection":
        return httpx.Response(200, json=[{"id": 1, "name": "Sales"}])
    return httpx.Response(404)


def _handler_api_key(request: httpx.Request) -> httpx.Response:
    if request.headers.get("X-API-KEY") != "the-key":
        return httpx.Response(401)
    return _handler(request)


def _api(**kwargs) -> MetabaseApi:
    return MetabaseApi(base_url="https://mb.example.com", transport=httpx.MockTransport(_handler), **kwargs)


def test_session_login_sets_header():
    api = _api(username="u", password="p")
    assert api.login() == "sess-tok"
    assert api._http.headers["X-Metabase-Session"] == "sess-tok"


def test_api_key_auth_skips_session_call():
    api = MetabaseApi(
        base_url="https://mb.example.com", api_key="the-key",
        transport=httpx.MockTransport(_handler_api_key),
    )
    assert api.list_databases()[0]["engine"] == "postgres"  # no /api/session call needed


def test_database_dialects_normalization():
    api = _api(username="u", password="p")
    assert api.database_dialects() == {1: "postgres", 2: "databricks"}


def test_normalize_metabase_engine_unknown_falls_back_to_other():
    assert normalize_metabase_engine("some-future-engine") == "other"
    assert normalize_metabase_engine(None) == "other"


def test_snapshot_assembles_all_endpoints():
    api = _api(username="u", password="p")
    snap = api.snapshot()
    assert {d["id"] for d in snap["databases"]} == {1, 2}
    (table,) = snap["tables"]
    assert table["name"] == "orders" and table["fields"][0]["name"] == "id"
    assert snap["cards"][0]["name"] == "Q1"
    assert snap["dashboards"][0] == {"id": 1, "name": "Ops", "dashcards": []}
    assert snap["collections"][0]["name"] == "Sales"
    assert snap["metrics"] == []  # no type=metric cards and /api/metric 404s -> []
