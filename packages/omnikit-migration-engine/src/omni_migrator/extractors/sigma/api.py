"""Sigma API client — the acquisition layer (mirrors `looker/api.py`'s client shape).

Sigma is API-only, like Metabase (§6.5) — no file artifact exists at all, everything is JSON
over a REST API. Unlike Metabase, auth is OAuth2 **client-credentials** (`POST /v2/auth/token`,
form-encoded `grant_type=client_credentials`), returning a Bearer JWT with a **1-hour expiry**
that's refreshed via its `refresh_token` rather than re-authenticating from scratch (plan §6.4).
There is also **no universal base URL** — it's per cloud/region and must come from the customer's
own Admin console (e.g. `aws-api.sigmacomputing.com`, `api.us-a.aws.sigmacomputing.com`, ...) — same
`--base-url` pattern already used for Looker/Omni, no special-casing needed here, just don't
hardcode a default. The httpx transport is injectable so the client is unit-testable without a
server. **Not verified against a live Sigma instance** — built from `help.sigmacomputing.com`'s
public docs/OpenAPI spec only (plan §6.4); treat with the same skepticism as Tableau's dashboard
translator until spot-checked live.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import httpx

# Sigma connection `type` -> IR `Dialect`. Only `"bigQuery"` is confirmed verbatim from the docs
# (plan §6.4's open item: "pull a real org's connection list and extend this before relying on it
# for anything beyond Snowflake/BigQuery"). Best-effort guesses for the others, matching the
# casing convention `bigQuery` implies (a plain camelCase product name).
_TYPE_DIALECT = {
    "bigquery": "bigquery",
    "snowflake": "snowflake",
    "redshift": "redshift",
    "postgresql": "postgres",
    "postgres": "postgres",
    "databricks": "databricks",
    "mysql": "mysql",
}


def normalize_sigma_connection_type(type_: str | None) -> str:
    if not type_:
        return "other"
    return _TYPE_DIALECT.get(type_.lower(), "other")


@dataclass
class SigmaApi:
    base_url: str
    client_id: str
    client_secret: str
    transport: httpx.BaseTransport | None = None  # inject a MockTransport in tests
    _http: httpx.Client = field(init=False, default=None)
    _token: str | None = field(init=False, default=None)
    _refresh_token: str | None = field(init=False, default=None)

    def __post_init__(self) -> None:
        self._http = httpx.Client(base_url=self.base_url.rstrip("/"), transport=self.transport, timeout=60.0)

    # --- auth ---
    def login(self) -> str:
        r = self._http.post(
            "/v2/auth/token",
            data={
                "grant_type": "client_credentials",
                "client_id": self.client_id,
                "client_secret": self.client_secret,
            },
        )
        r.raise_for_status()
        body = r.json()
        self._token = body["access_token"]
        self._refresh_token = body.get("refresh_token")
        self._http.headers["Authorization"] = f"Bearer {self._token}"
        return self._token

    def refresh(self) -> str:
        """Refresh an expired (1hr) token via its `refresh_token` rather than re-authenticating
        with client_id/client_secret from scratch (plan §6.4). Falls back to a fresh `login()`
        if no refresh_token was ever issued."""
        if not self._refresh_token:
            return self.login()
        r = self._http.post(
            "/v2/auth/token", data={"grant_type": "refresh_token", "refresh_token": self._refresh_token},
        )
        r.raise_for_status()
        body = r.json()
        self._token = body["access_token"]
        self._refresh_token = body.get("refresh_token", self._refresh_token)
        self._http.headers["Authorization"] = f"Bearer {self._token}"
        return self._token

    def _ensure_auth(self) -> None:
        if not self._token:
            self.login()

    def _get(self, path: str, **kwargs) -> httpx.Response:
        self._ensure_auth()
        r = self._http.get(path, **kwargs)
        if r.status_code == 401 and self._token:
            # Token expired mid-run (1hr window) — refresh once and retry, don't just fail.
            self.refresh()
            r = self._http.get(path, **kwargs)
        r.raise_for_status()
        return r

    # --- connections ---
    def list_connections(self) -> list[dict]:
        return self._paginate("/v2/connections")

    # --- data models (the modeling layer to build against — datasets are deprecated, §6.4) ---
    def list_data_models(self) -> list[dict]:
        return self._paginate("/v2/dataModels")

    def data_model_spec(self, data_model_id: str) -> dict:
        return self._get(f"/v2/dataModels/{data_model_id}/spec", params={"format": "json"}).json()

    def data_model_sources(self, data_model_id: str) -> list[dict]:
        return self._paginate(f"/v2/dataModels/{data_model_id}/sources")

    def data_model_columns(self, data_model_id: str) -> list[dict]:
        return self._paginate(f"/v2/dataModels/{data_model_id}/columns")

    # --- workbooks (dashboards) ---
    def list_workbooks(self) -> list[dict]:
        return self._paginate("/v2/workbooks")

    def get_workbook(self, workbook_id: str) -> dict:
        return self._get(f"/v2/workbooks/{workbook_id}").json()

    def workbook_pages(self, workbook_id: str) -> list[dict]:
        return self._paginate(f"/v2/workbooks/{workbook_id}/pages")

    def workbook_page_elements(self, workbook_id: str, page_id: str) -> list[dict]:
        return self._paginate(f"/v2/workbooks/{workbook_id}/pages/{page_id}/elements")

    def workbook_spec(self, workbook_id: str) -> dict:
        """Fallback for workbooks with no promoted data model — narrower than a data model's
        spec (tables/columns only, no charts/layout per Sigma's own docs; plan §6.4)."""
        return self._get(f"/v2/workbooks/{workbook_id}/spec", params={"format": "json"}).json()

    def _paginate(self, path: str, *, page_size: int = 1000) -> list[dict]:
        """Sigma pagination: default page size 50, max 1000 (plan §6.4) — request the max and
        follow `nextPage`/cursor-style continuation if the response indicates more pages exist.
        Not verified live; the exact continuation-token field name is a best-effort guess
        (`nextPage`) from the documented pagination-default/max values, not a confirmed field."""
        results: list[dict] = []
        params: dict = {"limit": page_size}
        while True:
            body = self._get(path, params=params).json()
            entries = body.get("entries", body) if isinstance(body, dict) else body
            results.extend(entries)
            next_page = body.get("nextPage") if isinstance(body, dict) else None
            if not next_page:
                return results
            params = {"limit": page_size, "page": next_page}

    # --- snapshot: the full offline/test/`--from-json` bundle in one call ---
    def snapshot(self) -> dict:
        """Pull every endpoint into one plain dict — this *is* the acquisition step for an
        API-only source (same shape as `MetabaseApi.snapshot()`, §6.5). Data model specs are
        fetched per data model since they're the actual modeling content; workbooks are listed
        with their pages/elements resolved eagerly the same way."""
        connections = self.list_connections()
        data_models = []
        for dm in self.list_data_models():
            spec = self.data_model_spec(dm["dataModelId"])
            data_models.append({**dm, "spec": spec})
        workbooks = []
        for wb in self.list_workbooks():
            pages = self.workbook_pages(wb["workbookId"])
            for page in pages:
                page["elements"] = self.workbook_page_elements(wb["workbookId"], page["pageId"])
            workbooks.append({**wb, "pages": pages})
        return {"connections": connections, "dataModels": data_models, "workbooks": workbooks}
