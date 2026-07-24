"""Looker API client — the 'connect' half of acquisition (plan §6.3).

Looker uses an OAuth2 client-credentials grant (per-instance API3 key), not user OAuth.
This client authenticates, lists dashboards (rankable by usage), and pulls **raw LookML**
project files — which are fed verbatim to the file-based `LookerExtractor` (one mapping
path). The httpx transport is injectable so the client is unit-testable without a server.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

import httpx

API = "/api/4.0"
MAX_GET_ATTEMPTS = 3
MAX_RETRY_DELAY_SECONDS = 2.0


@dataclass
class LookerDashboard:
    id: str
    title: str
    folder: str | None = None
    view_count: int = 0
    owner: str | None = None
    updated_at: str | None = None
    model: str | None = None


@dataclass
class LookerApi:
    base_url: str
    client_id: str
    client_secret: str
    transport: httpx.BaseTransport | None = None  # inject a MockTransport in tests
    _http: httpx.Client = field(init=False, default=None)
    _token: str | None = field(init=False, default=None)
    _look_cache: dict[str, dict] = field(init=False, default_factory=dict)
    _query_cache: dict[str, dict] = field(init=False, default_factory=dict)

    def __post_init__(self) -> None:
        self._http = httpx.Client(
            base_url=self.base_url.rstrip("/"), transport=self.transport, timeout=60.0
        )

    # --- auth ---
    def login(self) -> str:
        r = self._http.post(
            f"{API}/login",
            params={"client_id": self.client_id, "client_secret": self.client_secret},
        )
        r.raise_for_status()
        self._token = r.json()["access_token"]
        self._http.headers["Authorization"] = f"token {self._token}"
        return self._token

    def _ensure_auth(self) -> None:
        if not self._token:
            self.login()

    def _get(self, path: str, **kwargs) -> httpx.Response:
        self._ensure_auth()
        response: httpx.Response | None = None
        for attempt in range(MAX_GET_ATTEMPTS):
            response = self._http.get(path, **kwargs)
            if response.status_code not in (429, 500, 502, 503, 504):
                response.raise_for_status()
                return response
            if attempt + 1 < MAX_GET_ATTEMPTS:
                raw_delay = response.headers.get("Retry-After")
                try:
                    delay = float(raw_delay) if raw_delay is not None else 0.2 * (2 ** attempt)
                except ValueError:
                    delay = 0.2 * (2 ** attempt)
                time.sleep(max(0.0, min(delay, MAX_RETRY_DELAY_SECONDS)))
        assert response is not None
        response.raise_for_status()
        return response

    def close(self) -> None:
        self._http.close()

    # --- dashboards ---
    def list_dashboards(self) -> list[LookerDashboard]:
        rows = self._get(f"{API}/dashboards").json()
        out = []
        for d in rows:
            user = d.get("user") if isinstance(d.get("user"), dict) else {}
            model = d.get("model") if isinstance(d.get("model"), dict) else {}
            out.append(
                LookerDashboard(
                    id=str(d.get("id")),
                    title=d.get("title", ""),
                    folder=(d.get("folder") or {}).get("name") if isinstance(d.get("folder"), dict) else None,
                    view_count=int(d.get("view_count") or d.get("content_metadata", {}).get("view_count", 0) or 0),
                    owner=d.get("user_name") or user.get("display_name"),
                    updated_at=d.get("updated_at"),
                    model=model.get("id") or (d.get("model") if isinstance(d.get("model"), str) else None),
                )
            )
        return out

    def top_dashboards(self, limit: int = 20) -> list[LookerDashboard]:
        """Most-used dashboards first (by view_count), for the 'pick a series' flow."""
        return sorted(self.list_dashboards(), key=lambda d: d.view_count, reverse=True)[:limit]

    def get_dashboard(self, dashboard_id: str) -> dict:
        return self._get(f"{API}/dashboards/{dashboard_id}").json()

    def get_dashboard_elements(self, dashboard_id: str) -> list[dict]:
        payload = self._get(f"{API}/dashboards/{dashboard_id}/dashboard_elements").json()
        if isinstance(payload, list):
            return [item for item in payload if isinstance(item, dict)]
        if isinstance(payload, dict):
            rows = payload.get("dashboard_elements") or payload.get("elements") or []
            return [item for item in rows if isinstance(item, dict)] if isinstance(rows, list) else []
        return []

    def get_dashboard_filters(self, dashboard_id: str) -> list[dict]:
        payload = self._get(f"{API}/dashboards/{dashboard_id}/dashboard_filters").json()
        if isinstance(payload, list):
            return [item for item in payload if isinstance(item, dict)]
        if isinstance(payload, dict):
            rows = payload.get("dashboard_filters") or payload.get("filters") or []
            return [item for item in rows if isinstance(item, dict)] if isinstance(rows, list) else []
        return []

    def get_look(self, look_id: str) -> dict:
        key = str(look_id)
        if key not in self._look_cache:
            payload = self._get(f"{API}/looks/{key}").json()
            self._look_cache[key] = payload if isinstance(payload, dict) else {}
        return self._look_cache[key]

    def get_query(self, query_id: str) -> dict:
        key = str(query_id)
        if key not in self._query_cache:
            payload = self._get(f"{API}/queries/{key}").json()
            self._query_cache[key] = payload if isinstance(payload, dict) else {}
        return self._query_cache[key]

    def resolve_element_query(self, element: dict) -> tuple[dict | None, str, str | None]:
        """Resolve one dashboard element without hiding missing saved-Look evidence."""
        inline = element.get("query")
        if isinstance(inline, dict):
            return dict(inline), "inline", None

        result_maker = element.get("result_maker") if isinstance(element.get("result_maker"), dict) else {}
        result_query = result_maker.get("query")
        if isinstance(result_query, dict):
            return dict(result_query), "result_maker", None

        embedded_look = element.get("look") if isinstance(element.get("look"), dict) else {}
        look_id_value = element.get("look_id") or embedded_look.get("id")
        look_id = str(look_id_value) if look_id_value not in (None, "") else None
        embedded_query = embedded_look.get("query")
        if isinstance(embedded_query, dict):
            return dict(embedded_query), "saved_look", look_id

        try:
            look = self.get_look(look_id) if look_id else {}
        except httpx.HTTPStatusError as error:
            if error.response.status_code not in (403, 404):
                raise
            look = {}
        look_query = look.get("query") if isinstance(look, dict) else None
        if isinstance(look_query, dict):
            return dict(look_query), "saved_look", look_id

        query_id_value = (
            element.get("query_id")
            or result_maker.get("query_id")
            or embedded_look.get("query_id")
            or (look.get("query_id") if isinstance(look, dict) else None)
        )
        if query_id_value not in (None, ""):
            try:
                query = self.get_query(str(query_id_value))
            except httpx.HTTPStatusError as error:
                if error.response.status_code not in (403, 404):
                    raise
                query = {}
            if query:
                return dict(query), "query_id", look_id
        return None, "unknown", look_id

    def get_dashboard_complete(self, dashboard_id: str) -> dict:
        """Return selected dashboard metadata with authoritative element/filter collections."""
        dashboard = dict(self.get_dashboard(dashboard_id))
        elements = self.get_dashboard_elements(dashboard_id)
        look_ids: set[str] = set()
        query_ids: set[str] = set()
        unresolved_element_ids: list[str] = []
        for element in elements:
            query, origin, look_id = self.resolve_element_query(element)
            element["_omnikit_query_origin"] = origin
            if look_id:
                element["_omnikit_source_look_id"] = look_id
                look_ids.add(look_id)
            if query is not None:
                query = dict(query)
                query["_omnikit_query_origin"] = origin
                if look_id:
                    query["_omnikit_source_look_id"] = look_id
                element["_omnikit_resolved_query"] = query
                if query.get("id") not in (None, ""):
                    query_ids.add(str(query["id"]))
            elif element.get("type") not in ("text", "note") and not element.get("body_text"):
                unresolved_element_ids.append(str(element.get("id") or "unknown"))
        dashboard["dashboard_elements"] = elements
        dashboard["dashboard_filters"] = self.get_dashboard_filters(dashboard_id)
        dashboard["_omnikit_acquisition"] = {
            "contract": "looker-professional-v2",
            "dashboard_id": str(dashboard_id),
            "detail_endpoints": ["dashboard_elements", "dashboard_filters", "looks", "queries"],
            "look_ids": sorted(look_ids),
            "query_ids": sorted(query_ids),
            "unresolved_element_ids": sorted(unresolved_element_ids),
        }
        return dashboard

    # --- connections (resolve a LookML model's connection -> warehouse dialect) ---
    def list_connections(self) -> list[dict]:
        return self._get(f"{API}/connections").json()

    def connection_dialects(self) -> dict[str, str]:
        """{connection_name: normalized IR dialect} for connection mapping."""
        out: dict[str, str] = {}
        for c in self.list_connections():
            d = c.get("dialect")
            raw = c.get("dialect_name") or (d.get("name") if isinstance(d, dict) else d)
            out[c.get("name")] = normalize_looker_dialect(raw)
        return out

    # --- LookML (raw project files, dev access) ---
    def list_projects(self) -> list[dict]:
        return self._get(f"{API}/projects").json()

    def project_files(self, project_id: str) -> list[dict]:
        return self._get(f"{API}/projects/{project_id}/files").json()

    def project_file_content(self, project_id: str, file_id: str) -> str:
        r = self._get(f"{API}/projects/{project_id}/files/file", params={"file_id": file_id})
        # Looker may return raw text or a JSON object with a `content` field.
        try:
            return r.json().get("content", r.text)
        except ValueError:
            return r.text


# Looker dialect name -> IR dialect (omni_migrator.ir.schema.Dialect).
_LOOKER_DIALECT = {
    "snowflake": "snowflake",
    "bigquery_standard_sql": "bigquery",
    "bigquery_legacy_sql": "bigquery",
    "bigquery": "bigquery",
    "redshift": "redshift",
    "postgres": "postgres",
    "mysql": "mysql",
    "spark": "databricks",
    "databricks": "databricks",
}


def normalize_looker_dialect(raw: str | None) -> str:
    if not raw:
        return "other"
    return _LOOKER_DIALECT.get(raw.lower(), "other")


def fetch_lookml_files(api: LookerApi, project_id: str) -> dict[str, str]:
    """Pull every .lkml file's raw text from a project: {file_path: lkml_text}."""
    out: dict[str, str] = {}
    for f in api.project_files(project_id):
        path = f.get("path") or f.get("name") or ""
        if not path.endswith((".lkml", ".lookml")):
            continue
        file_id = f.get("id") or path
        out[path] = api.project_file_content(project_id, file_id)
    return out
