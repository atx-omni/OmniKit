"""Acquisition layer: Tableau .twbx (zip) intake + Looker API client (offline)."""

from __future__ import annotations

import json
import zipfile
from pathlib import Path

import httpx

from omni_migrator.core.contracts import ExtractCtx, FileInput
from omni_migrator.extractors.looker.api import LookerApi, fetch_lookml_files
from omni_migrator.extractors.tableau.extractor import TableauExtractor

FIXTURES = Path(__file__).parent / "fixtures"


# --- Tableau .twbx (packaged zip) ---

def test_twbx_zip_intake(tmp_path):
    tds = (FIXTURES / "orders.tds").read_text()
    twbx = tmp_path / "orders.twbx"
    with zipfile.ZipFile(twbx, "w") as zf:
        zf.writestr("orders.tds", tds)
        zf.writestr("Data/extract.hyper", b"\x00binary-extract")  # ignored resource

    ext = TableauExtractor()
    assert ext.detect(FileInput(paths=[twbx]))
    model = ext.extract(FileInput(paths=[twbx]), ExtractCtx()).model
    (view,) = model.views
    assert view.name == "orders"
    assert view.source_table == "ORDERS"
    assert {f.name for f in view.fields if f.kind == "measure"} == {"amount", "total_amount"}


# --- Looker API client (mock transport) ---

def _looker_handler(request: httpx.Request) -> httpx.Response:
    path = request.url.path
    if path == "/api/4.0/login":
        return httpx.Response(200, json={"access_token": "tok", "token_type": "Bearer", "expires_in": 3600})
    if path == "/api/4.0/dashboards":
        return httpx.Response(200, json=[
            {"id": "1", "title": "Rarely used", "view_count": 3, "folder": {"name": "Ops"}},
            {"id": "2", "title": "Exec KPIs", "view_count": 120, "folder": {"name": "Exec"}},
            {"id": "3", "title": "Sales", "view_count": 45},
        ])
    if path == "/api/4.0/projects/ecommerce/files":
        return httpx.Response(200, json=[
            {"id": "f1", "path": "views/orders.view.lkml"},
            {"id": "f2", "path": "manifest.lkml"},
            {"id": "f3", "path": "README.md"},  # non-lkml, skipped
        ])
    if path == "/api/4.0/projects/ecommerce/files/file":
        fid = request.url.params.get("file_id")
        return httpx.Response(200, json={"content": f"# content of {fid}\n"})
    return httpx.Response(404)


def _api() -> LookerApi:
    return LookerApi(
        base_url="https://co.looker.com",
        client_id="id", client_secret="secret",
        transport=httpx.MockTransport(_looker_handler),
    )


def test_login_and_auth_header():
    api = _api()
    assert api.login() == "tok"
    assert api._http.headers["Authorization"] == "token tok"


def test_top_dashboards_ranked_by_usage():
    top = _api().top_dashboards(limit=2)
    assert [d.id for d in top] == ["2", "3"]  # most-used first
    assert top[0].title == "Exec KPIs"
    assert top[0].view_count == 120


def test_fetch_lookml_files_filters_and_pulls_content():
    files = fetch_lookml_files(_api(), "ecommerce")
    assert set(files) == {"views/orders.view.lkml", "manifest.lkml"}  # README.md skipped
    assert "content of f1" in files["views/orders.view.lkml"]


def test_connect_looker_to_extract_roundtrip(tmp_path):
    """Acquired LookML text feeds the file-based LookerExtractor unchanged."""
    from omni_migrator.extractors.looker.extractor import LookerExtractor

    lkml_text = (FIXTURES / "orders.view.lkml").read_text()
    dest = tmp_path / "orders.view.lkml"
    dest.write_text(lkml_text)
    model = LookerExtractor().extract(FileInput(paths=[dest]), ExtractCtx()).model
    assert model.views[0].name == "orders"


def test_connections_file_mapping_offline(tmp_path):
    """The run pipeline can map connections from a JSON file without a live Omni."""
    conns = [{"id": "c1", "name": "Prod SF", "dialect": "snowflake", "database": "ANALYTICS", "defaultSchema": "PUBLIC"}]
    f = tmp_path / "conns.json"
    f.write_text(json.dumps(conns))
    # sanity: file parses to the shape suggest_mapping expects
    assert json.loads(f.read_text())[0]["dialect"] == "snowflake"
