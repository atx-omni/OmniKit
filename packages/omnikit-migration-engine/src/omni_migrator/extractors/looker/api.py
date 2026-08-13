"""Read-only Looker API acquisition.

Looker uses an instance API client ID and secret to obtain a short-lived API token. The
documented API can return compiled Explore, dashboard, Look, and query definitions, but its
project-file endpoints expose project metadata rather than a supported raw LookML-content
contract. Raw ``.lkml`` acquisition therefore remains a Git/manual-files responsibility.

The transport is injectable so callers can exercise the exact acquisition contract without a
live Looker instance.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

import httpx

API = "/api/4.0"
MAX_GET_ATTEMPTS = 3
MAX_RETRY_DELAY_SECONDS = 2.0
MAX_COMPILED_EXPLORES = 200
MAX_SELECTED_DASHBOARDS = 200


class RawLookmlApiUnavailableError(RuntimeError):
    """Raised when a caller attempts to treat project metadata as raw LookML content."""


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
    client_secret: str = field(repr=False)
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
            data={"client_id": self.client_id, "client_secret": self.client_secret},
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

    # --- compiled semantic definitions ---
    def list_lookml_models(self) -> list[dict]:
        payload = self._get(f"{API}/lookml_models").json()
        if isinstance(payload, list):
            return [item for item in payload if isinstance(item, dict)]
        if isinstance(payload, dict):
            rows = payload.get("lookml_models") or payload.get("models") or []
            return [item for item in rows if isinstance(item, dict)] if isinstance(rows, list) else []
        return []

    def get_compiled_explore(self, model_name: str, explore_name: str) -> dict:
        """Return Looker's compiled Explore definition, not raw LookML source text."""
        payload = self._get(
            f"{API}/lookml_models/{model_name}/explores/{explore_name}"
        ).json()
        if not isinstance(payload, dict):
            raise ValueError(
                f"Looker compiled Explore {model_name}/{explore_name} returned a non-object"
            )
        return payload

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
        # The dashboard payload can contain embedded detail arrays, but those fields may be
        # stale or projection-limited. The documented detail endpoints are the authoritative
        # acquisition contract for a selected dashboard, so always replace embedded copies.
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

    # --- LookML project metadata (not raw file contents) ---
    def list_projects(self) -> list[dict]:
        return self._get(f"{API}/projects").json()

    def project_files(self, project_id: str) -> list[dict]:
        """List project-file metadata for diagnostics and manual/Git closure guidance."""
        return self._get(f"{API}/projects/{project_id}/files").json()

    def project_file_content(self, project_id: str, file_id: str) -> str:
        del project_id, file_id
        raise RawLookmlApiUnavailableError(
            "Looker API project-file endpoints are not an approved raw LookML-content "
            "contract. Export the selected .lkml closure from Git or use Manual Files."
        )

    @staticmethod
    def _model_explore_names(model: dict) -> list[str]:
        rows = model.get("explores") or []
        if not isinstance(rows, list):
            return []
        names: list[str] = []
        for item in rows:
            name = item.get("name") if isinstance(item, dict) else item
            if name not in (None, ""):
                names.append(str(name))
        return names

    @staticmethod
    def _query_pair(query: dict) -> tuple[str, str] | None:
        model = query.get("model") or query.get("model_name")
        explore = query.get("view") or query.get("explore")
        if model in (None, "") or explore in (None, ""):
            return None
        return str(model), str(explore)

    def compiled_evidence_snapshot(
        self,
        *,
        project_ids: list[str] | None = None,
        explore_pairs: list[tuple[str, str]] | None = None,
        dashboard_ids: list[str] | None = None,
    ) -> dict:
        """Acquire a bounded, secret-free snapshot of documented compiled definitions.

        ``project_ids`` only scopes model discovery. It never implies that raw project files were
        retrieved. When dashboards are selected, their resolved query model/Explore pairs are
        added to the semantic scope automatically.
        """
        selected_dashboards = list(dict.fromkeys(str(item) for item in (dashboard_ids or []) if str(item).strip()))
        if len(selected_dashboards) > MAX_SELECTED_DASHBOARDS:
            raise ValueError(
                f"Select at most {MAX_SELECTED_DASHBOARDS} Looker dashboards per acquisition run"
            )
        dashboards = [self.get_dashboard_complete(item) for item in selected_dashboards]

        selected_pairs = {
            (str(model).strip(), str(explore).strip())
            for model, explore in (explore_pairs or [])
            if str(model).strip() and str(explore).strip()
        }
        for dashboard in dashboards:
            for element in dashboard.get("dashboard_elements", []) or []:
                query = element.get("_omnikit_resolved_query")
                if not isinstance(query, dict):
                    continue
                pair = self._query_pair(query)
                if pair:
                    selected_pairs.add(pair)

        models = self.list_lookml_models()
        selected_projects = {str(item) for item in (project_ids or []) if str(item).strip()}
        if not selected_pairs:
            scoped_models = [
                model for model in models
                if not selected_projects
                or str(model.get("project_name") or model.get("project_id") or "") in selected_projects
            ]
            if not selected_projects and len(scoped_models) != 1:
                raise ValueError(
                    "Select Looker project IDs, compiled Explore pairs, or dashboards before API semantic acquisition"
                )
            for model in scoped_models:
                model_name = str(model.get("name") or "").strip()
                selected_pairs.update(
                    (model_name, explore_name)
                    for explore_name in self._model_explore_names(model)
                    if model_name and explore_name
                )

        if not selected_pairs:
            raise ValueError("The selected Looker scope resolved no compiled Explores")
        if len(selected_pairs) > MAX_COMPILED_EXPLORES:
            raise ValueError(
                f"The Looker scope resolved {len(selected_pairs)} Explores; narrow it to "
                f"{MAX_COMPILED_EXPLORES} or fewer"
            )

        explores = [
            {
                "modelName": model_name,
                "exploreName": explore_name,
                "definition": self.get_compiled_explore(model_name, explore_name),
            }
            for model_name, explore_name in sorted(selected_pairs)
        ]
        return {
            "models": models,
            "explores": explores,
            "dashboards": dashboards,
            "connections": self.list_connections(),
            "_omnikit_acquisition": {
                "contract": "looker-compiled-api-v1",
                "definitionClass": "compiled_definition",
                "rawLookmlRetrieved": False,
                "projectIds": sorted(selected_projects),
                "dashboardIds": selected_dashboards,
                "explorePairs": [
                    {"model": model_name, "explore": explore_name}
                    for model_name, explore_name in sorted(selected_pairs)
                ],
                "manualRequirements": [
                    "Provide the selected raw LookML dependency closure from Git or Manual Files "
                    "before release validation."
                ],
            },
        }


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
    """Compatibility guard for the removed, unsupported raw-project-content assumption."""
    del api, project_id
    raise RawLookmlApiUnavailableError(
        "Raw LookML cannot be acquired through the approved Looker API contract. "
        "Use Git or Manual Files for .lkml content."
    )
