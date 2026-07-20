"""Metabase API client — the acquisition layer (mirrors `looker/api.py`'s client shape).

Metabase is API-only: unlike Looker (which is API-based for acquisition but still feeds a
file-based extractor), there's no raw artifact to pull down first — `snapshot()` *is* the
acquisition step, and its plain-dict output is exactly what `extractors/metabase/extractor.py`'s
pure `_build_bundle` consumes (and what a `--from-json` offline fixture contains too — see plan
risk #5). The httpx transport is injectable so the client is unit-testable without a server.

Supports both auth styles Metabase instances use in the wild: session-token login (`POST
/api/session`, all versions) and API-key (`X-API-KEY` header, newer versions only). There's no
capability-discovery endpoint to probe which an instance supports ahead of time (plan risk #4), so
the caller picks by which credentials it has, and a 401 fails loudly rather than silently retrying
the other method.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import httpx

# Metabase `database.engine` -> IR `Dialect`. Best-effort mapping (not exhaustive of every
# Metabase-supported engine) — unknown engines fall back to `"other"`.
_ENGINE_DIALECT = {
    "postgres": "postgres",
    "mysql": "mysql",
    "redshift": "redshift",
    "bigquery": "bigquery",
    "bigquery-cloud-sdk": "bigquery",
    "snowflake": "snowflake",
    "sparksql": "databricks",
    "databricks": "databricks",
}


def normalize_metabase_engine(engine: str | None) -> str:
    if not engine:
        return "other"
    return _ENGINE_DIALECT.get(engine.lower(), "other")


@dataclass
class MetabaseApi:
    base_url: str
    username: str | None = None
    password: str | None = None
    api_key: str | None = None
    transport: httpx.BaseTransport | None = None  # inject a MockTransport in tests
    _http: httpx.Client = field(init=False, default=None)
    _session_token: str | None = field(init=False, default=None)

    def __post_init__(self) -> None:
        self._http = httpx.Client(base_url=self.base_url.rstrip("/"), transport=self.transport, timeout=60.0)
        if self.api_key:
            self._http.headers["X-API-KEY"] = self.api_key

    # --- auth ---
    def login(self) -> str:
        if self.api_key:
            return self.api_key  # already set as a header in __post_init__; no session call needed
        r = self._http.post("/api/session", json={"username": self.username, "password": self.password})
        r.raise_for_status()
        self._session_token = r.json()["id"]
        self._http.headers["X-Metabase-Session"] = self._session_token
        return self._session_token

    def _ensure_auth(self) -> None:
        if not self.api_key and not self._session_token:
            self.login()

    def _get(self, path: str, **kwargs) -> httpx.Response:
        self._ensure_auth()
        r = self._http.get(path, **kwargs)
        r.raise_for_status()
        return r

    # --- databases ---
    def list_databases(self) -> list[dict]:
        data = self._get("/api/database").json()
        return data.get("data", data) if isinstance(data, dict) else data  # paginated on newer versions

    def database_dialects(self) -> dict[int, str]:
        return {d["id"]: normalize_metabase_engine(d.get("engine")) for d in self.list_databases()}

    # --- tables / fields ---
    def list_tables(self, database_id: int | None = None) -> list[dict]:
        tables = self._get("/api/table").json()
        if database_id is not None:
            tables = [t for t in tables if t.get("db_id") == database_id]
        return tables

    def table_query_metadata(self, table_id: int) -> dict:
        return self._get(f"/api/table/{table_id}/query_metadata").json()

    # --- segments / metrics ---
    def list_segments(self) -> list[dict]:
        return self._get("/api/segment").json()

    def list_metrics(self) -> list[dict]:
        """`type=metric` cards (Metabase >= 49) if any exist, else the legacy `/api/metric`
        endpoint (plan risk #2 — which shape a target instance actually exposes isn't knowable
        ahead of time, so both are tried rather than assumed)."""
        metrics = [c for c in self.list_cards() if c.get("type") == "metric"]
        if metrics:
            return metrics
        try:
            return self._get("/api/metric").json()
        except httpx.HTTPStatusError:
            return []

    # --- cards / dashboards / collections ---
    def list_cards(self) -> list[dict]:
        return self._get("/api/card").json()

    def get_card(self, card_id: int) -> dict:
        return self._get(f"/api/card/{card_id}").json()

    def list_dashboards(self) -> list[dict]:
        return self._get("/api/dashboard").json()

    def get_dashboard(self, dashboard_id: int) -> dict:
        return self._get(f"/api/dashboard/{dashboard_id}").json()

    def list_collections(self) -> list[dict]:
        return self._get("/api/collection").json()

    # --- snapshot: the full offline/test/`--from-json` bundle in one call ---
    def snapshot(self) -> dict:
        """Pull every endpoint into one plain dict — this *is* the acquisition step for an
        API-only source. Cards are fetched once and reused for the legacy-vs-new metric check,
        instead of `list_metrics()`'s own extra `/api/card` call."""
        cards = self.list_cards()
        metrics = [c for c in cards if c.get("type") == "metric"]
        if not metrics:
            try:
                metrics = self._get("/api/metric").json()
            except httpx.HTTPStatusError:
                metrics = []
        tables = []
        for t in self.list_tables():
            meta = self.table_query_metadata(t["id"])
            tables.append({**t, "fields": meta.get("fields", [])})
        dashboards = [self.get_dashboard(dashboard["id"]) for dashboard in self.list_dashboards()]
        return {
            "databases": self.list_databases(),
            "tables": tables,
            "segments": self.list_segments(),
            "metrics": metrics,
            "cards": cards,
            "dashboards": dashboards,
            "collections": self.list_collections(),
        }
