"""Looker API client — the 'connect' half of acquisition (plan §6.3).

Looker uses an OAuth2 client-credentials grant (per-instance API3 key), not user OAuth.
This client authenticates, lists dashboards (rankable by usage), and pulls **raw LookML**
project files — which are fed verbatim to the file-based `LookerExtractor` (one mapping
path). The httpx transport is injectable so the client is unit-testable without a server.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import httpx

API = "/api/4.0"


@dataclass
class LookerDashboard:
    id: str
    title: str
    folder: str | None = None
    view_count: int = 0


@dataclass
class LookerApi:
    base_url: str
    client_id: str
    client_secret: str
    transport: httpx.BaseTransport | None = None  # inject a MockTransport in tests
    _http: httpx.Client = field(init=False, default=None)
    _token: str | None = field(init=False, default=None)

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
        r = self._http.get(path, **kwargs)
        r.raise_for_status()
        return r

    def close(self) -> None:
        self._http.close()

    # --- dashboards ---
    def list_dashboards(self) -> list[LookerDashboard]:
        rows = self._get(f"{API}/dashboards").json()
        out = []
        for d in rows:
            out.append(
                LookerDashboard(
                    id=str(d.get("id")),
                    title=d.get("title", ""),
                    folder=(d.get("folder") or {}).get("name") if isinstance(d.get("folder"), dict) else None,
                    view_count=int(d.get("view_count") or d.get("content_metadata", {}).get("view_count", 0) or 0),
                )
            )
        return out

    def top_dashboards(self, limit: int = 20) -> list[LookerDashboard]:
        """Most-used dashboards first (by view_count), for the 'pick a series' flow."""
        return sorted(self.list_dashboards(), key=lambda d: d.view_count, reverse=True)[:limit]

    def get_dashboard(self, dashboard_id: str) -> dict:
        return self._get(f"{API}/dashboards/{dashboard_id}").json()

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
