"""Read-only Sigma REST API acquisition for migration snapshots.

Live Sigma acquisition uses OAuth2 client credentials. The API host is organization/region
specific, so callers must provide it. This client intentionally keeps the transport injectable:
tests use ``httpx.MockTransport`` and production callers use httpx's default transport. Offline
manual acquisition consumes the versioned snapshot produced by this client.

The snapshot is evidence, not a portable Sigma definition. It combines data-model specs with
document sources, formula-bearing columns, workbook controls, generated SQL, lineage, grants,
and schedules. Newer or permission-gated endpoints are optional and produce sanitized
diagnostics instead of making an otherwise usable snapshot fail.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import TypeVar

import httpx

MAX_GET_ATTEMPTS = 3
MAX_RETRY_DELAY_SECONDS = 2.0
MAX_PAGINATION_PAGES = 10_000
RETRYABLE_STATUS_CODES = {429, 500, 502, 503, 504}
OPTIONAL_ENDPOINT_STATUS_CODES = {400, 403, 404, 405, 422, 501}

_T = TypeVar("_T")

# Sigma connection `type` -> IR `Dialect`. Only `bigQuery` is confirmed verbatim in Sigma's
# public examples; unknown future values deliberately remain `other`.
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


def _row_id(row: dict, *keys: str) -> str | None:
    for key in keys:
        value = row.get(key)
        if value not in (None, ""):
            return str(value)
    return None


@dataclass
class SigmaApi:
    base_url: str
    client_id: str = field(repr=False)
    client_secret: str = field(repr=False)
    transport: httpx.BaseTransport | None = None  # inject a MockTransport in tests
    _http: httpx.Client = field(init=False, repr=False)
    _token: str | None = field(init=False, default=None, repr=False)
    _refresh_token: str | None = field(init=False, default=None, repr=False)

    def __post_init__(self) -> None:
        self._http = httpx.Client(
            base_url=self.base_url.rstrip("/"), transport=self.transport, timeout=60.0
        )

    # --- auth and transport ---
    def _post_token(self, data: dict[str, str]) -> httpx.Response:
        response: httpx.Response | None = None
        for attempt in range(MAX_GET_ATTEMPTS):
            response = self._http.post("/v2/auth/token", data=data)
            if response.status_code not in RETRYABLE_STATUS_CODES:
                response.raise_for_status()
                return response
            if attempt + 1 < MAX_GET_ATTEMPTS:
                time.sleep(self._retry_delay(response, attempt))
        assert response is not None
        response.raise_for_status()
        return response

    def login(self) -> str:
        response = self._post_token(
            {
                "grant_type": "client_credentials",
                "client_id": self.client_id,
                "client_secret": self.client_secret,
            }
        )
        body = response.json()
        self._token = body["access_token"]
        self._refresh_token = body.get("refresh_token")
        self._http.headers["Authorization"] = f"Bearer {self._token}"
        return self._token

    def refresh(self) -> str:
        """Refresh an expired token, falling back to a new client-credentials login."""
        if not self._refresh_token:
            return self.login()
        response = self._post_token(
            {"grant_type": "refresh_token", "refresh_token": self._refresh_token}
        )
        body = response.json()
        self._token = body["access_token"]
        self._refresh_token = body.get("refresh_token", self._refresh_token)
        self._http.headers["Authorization"] = f"Bearer {self._token}"
        return self._token

    def _ensure_auth(self) -> None:
        if not self._token:
            self.login()

    @staticmethod
    def _retry_delay(response: httpx.Response, attempt: int) -> float:
        raw_delay = response.headers.get("Retry-After")
        try:
            delay = float(raw_delay) if raw_delay is not None else 0.2 * (2**attempt)
        except ValueError:
            delay = 0.2 * (2**attempt)
        return max(0.0, min(delay, MAX_RETRY_DELAY_SECONDS))

    def _get(self, path: str | httpx.URL, **kwargs) -> httpx.Response:
        self._ensure_auth()
        refreshed = False
        response: httpx.Response | None = None
        for attempt in range(MAX_GET_ATTEMPTS):
            response = self._http.get(path, **kwargs)
            if response.status_code == 401 and not refreshed:
                self.refresh()
                refreshed = True
                response = self._http.get(path, **kwargs)
            if response.status_code not in RETRYABLE_STATUS_CODES:
                response.raise_for_status()
                return response
            if attempt + 1 < MAX_GET_ATTEMPTS:
                time.sleep(self._retry_delay(response, attempt))
        assert response is not None
        response.raise_for_status()
        return response

    def close(self) -> None:
        self._http.close()

    # --- pagination ---
    @staticmethod
    def _page_parts(
        body: object, path: str
    ) -> tuple[list[dict], tuple[str, str] | None, bool | None, int | None]:
        if isinstance(body, list):
            if not all(isinstance(row, dict) for row in body):
                raise ValueError(f"Sigma pagination at {path} returned non-object rows")
            return list(body), None, None, None
        if not isinstance(body, dict):
            raise ValueError(f"Sigma pagination at {path} returned a non-list/object payload")

        containers = [body]
        nested = body.get("data")
        if isinstance(nested, dict):
            containers.insert(0, nested)

        page = next(
            (
                container
                for container in containers
                if any(key in container for key in ("entries", "items", "results"))
            ),
            None,
        )
        if page is None and isinstance(body.get("data"), list):
            rows: object = body["data"]
            page = body
        elif page is not None:
            rows = next((page[key] for key in ("entries", "items", "results") if key in page), [])
        else:
            raise ValueError(f"Sigma pagination at {path} omitted its entries collection")
        if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
            raise ValueError(f"Sigma pagination at {path} returned malformed entries")

        continuation: tuple[str, str] | None = None
        for container in containers:
            token = container.get(
                "nextPage",
                container.get("next_page", container.get("nextPageToken")),
            )
            if token not in (None, ""):
                continuation = (
                    "pageToken" if container.get("nextPageToken") not in (None, "") else "page",
                    str(token),
                )
                break
            links = container.get("links") if isinstance(container.get("links"), dict) else {}
            link = container.get("next") or links.get("next")
            if isinstance(link, dict):
                link = link.get("href")
            if link not in (None, ""):
                continuation = ("url", str(link))
                break

        has_more: bool | None = None
        total: int | None = None
        for container in containers:
            if has_more is None and isinstance(container.get("hasMore"), bool):
                has_more = container["hasMore"]
            raw_total = container.get("total")
            if total is None and isinstance(raw_total, (int, float)):
                numeric_total = float(raw_total)
                if numeric_total.is_integer() and numeric_total >= 0:
                    total = int(numeric_total)
        return list(rows), continuation, has_more, total

    def _same_origin_url(self, link: str, current_url: httpx.URL) -> httpx.URL:
        target = current_url.join(link)
        base = self._http.base_url
        if (target.scheme, target.host, target.port) != (base.scheme, base.host, base.port):
            raise RuntimeError("Sigma pagination refused a continuation URL on another origin")
        return target

    def _paginate(
        self, path: str, *, page_size: int = 1000, params: dict | None = None
    ) -> list[dict]:
        """Follow Sigma cursor or same-origin link pagination without silently truncating."""
        if not 1 <= page_size <= 1000:
            raise ValueError("Sigma page_size must be between 1 and 1000")

        base_params = dict(params or {})
        base_params["limit"] = page_size
        request_path: str | httpx.URL = path
        request_params: dict | None = dict(base_params)
        results: list[dict] = []
        seen: set[tuple[str, str]] = set()
        expected_total: int | None = None

        for _ in range(MAX_PAGINATION_PAGES):
            response = self._get(request_path, params=request_params)
            rows, continuation, has_more, total = self._page_parts(response.json(), path)
            results.extend(rows)
            if total is not None:
                expected_total = total

            if continuation is None:
                if has_more is True:
                    raise RuntimeError(
                        f"Sigma pagination at {path} reported hasMore without a continuation"
                    )
                if expected_total is not None and len(results) < expected_total:
                    raise RuntimeError(
                        f"Sigma pagination at {path} stopped after {len(results)} of "
                        f"{expected_total} entries"
                    )
                return results
            if continuation in seen:
                raise RuntimeError(f"Sigma pagination at {path} repeated its continuation")
            seen.add(continuation)

            kind, value = continuation
            if kind in ("page", "pageToken"):
                request_path = path
                request_params = {**base_params, kind: value}
            else:
                request_path = self._same_origin_url(value, response.request.url)
                request_params = None
        raise RuntimeError(f"Sigma pagination at {path} exceeded its page safety limit")

    # --- inventory and data models ---
    def list_connections(self) -> list[dict]:
        return self._paginate("/v2/connections")

    def list_data_models(self) -> list[dict]:
        return self._paginate("/v2/dataModels")

    def data_model_spec(self, data_model_id: str) -> dict:
        return self._get(f"/v2/dataModels/{data_model_id}/spec", params={"format": "json"}).json()

    def data_model_sources(self, data_model_id: str) -> list[dict]:
        return self._paginate(f"/v2/dataModels/{data_model_id}/sources")

    def data_model_columns(self, data_model_id: str) -> list[dict]:
        return self._paginate(f"/v2/dataModels/{data_model_id}/columns")

    def data_model_lineage(self, data_model_id: str) -> list[dict]:
        return self._paginate(f"/v2/dataModels/{data_model_id}/lineage")

    def data_model_materialization_schedules(self, data_model_id: str) -> list[dict]:
        return self._paginate(f"/v2/dataModels/{data_model_id}/materialization-schedules")

    def data_model_grants(self, data_model_id: str) -> list[dict]:
        return self.list_grants(data_model_id)

    # --- workbooks ---
    def list_workbooks(self) -> list[dict]:
        return self._paginate("/v2/workbooks")

    def get_workbook(self, workbook_id: str) -> dict:
        return self._get(f"/v2/workbooks/{workbook_id}").json()

    def workbook_sources(self, workbook_id: str) -> list[dict]:
        return self._paginate(f"/v2/workbooks/{workbook_id}/sources")

    def workbook_pages(self, workbook_id: str) -> list[dict]:
        return self._paginate(f"/v2/workbooks/{workbook_id}/pages")

    def workbook_page_elements(self, workbook_id: str, page_id: str) -> list[dict]:
        return self._paginate(f"/v2/workbooks/{workbook_id}/pages/{page_id}/elements")

    def workbook_elements(self, workbook_id: str) -> list[dict]:
        return self._paginate(f"/v2/workbooks/{workbook_id}/elements")

    def workbook_columns(self, workbook_id: str) -> list[dict]:
        return self._paginate(f"/v2/workbooks/{workbook_id}/columns")

    def workbook_element_columns(self, workbook_id: str, element_id: str) -> list[dict]:
        return self._paginate(f"/v2/workbooks/{workbook_id}/elements/{element_id}/columns")

    def workbook_controls(self, workbook_id: str) -> list[dict]:
        return self._paginate(f"/v2/workbooks/{workbook_id}/controls")

    def workbook_queries(self, workbook_id: str) -> list[dict]:
        return self._paginate(f"/v2/workbooks/{workbook_id}/queries")

    def workbook_element_query(self, workbook_id: str, element_id: str) -> dict:
        return self._get(f"/v2/workbooks/{workbook_id}/elements/{element_id}/query").json()

    def workbook_lineage(self, workbook_id: str) -> list[dict]:
        return self._paginate(f"/v2/workbooks/{workbook_id}/lineage")

    def workbook_element_lineage(self, workbook_id: str, element_id: str) -> dict:
        return self._get(f"/v2/workbooks/{workbook_id}/lineage/elements/{element_id}").json()

    def list_grants(self, inode_id: str) -> list[dict]:
        return self._paginate("/v2/grants", params={"inodeId": inode_id})

    def workbook_grants(self, workbook_id: str) -> list[dict]:
        return self.list_grants(workbook_id)

    def workbook_schedules(self, workbook_id: str) -> list[dict]:
        return self._paginate(f"/v2/workbooks/{workbook_id}/schedules")

    def workbook_materialization_schedules(self, workbook_id: str) -> list[dict]:
        return self._paginate(f"/v2/workbooks/{workbook_id}/materialization-schedules")

    def workbook_spec(self, workbook_id: str) -> dict:
        """Fallback modeling spec for a workbook without a promoted data model."""
        return self._get(f"/v2/workbooks/{workbook_id}/spec", params={"format": "json"}).json()

    # --- optional endpoint handling and snapshot assembly ---
    def _optional(
        self,
        diagnostics: list[dict],
        *,
        operation: str,
        endpoint: str,
        fetch: Callable[[], _T],
        default: _T,
    ) -> _T:
        try:
            return fetch()
        except httpx.HTTPStatusError as error:
            status_code = error.response.status_code
            if status_code not in OPTIONAL_ENDPOINT_STATUS_CODES:
                raise
            diagnostics.append(
                {
                    "operation": operation,
                    "endpoint": endpoint,
                    "status_code": status_code,
                    "status": "unavailable",
                }
            )
            return default

    @staticmethod
    def _combine_elements(bulk: list[dict], pages: list[dict]) -> list[dict]:
        combined: list[dict] = []
        positions: dict[str, int] = {}
        for element in [*bulk, *(item for page in pages for item in page.get("elements", []))]:
            record = dict(element)
            element_id = _row_id(record, "elementId", "id")
            if element_id is None or element_id not in positions:
                if element_id is not None:
                    positions[element_id] = len(combined)
                combined.append(record)
                continue
            index = positions[element_id]
            combined[index] = {**combined[index], **record}
        return combined

    @staticmethod
    def _merge_element_columns(element: dict, columns: list[dict]) -> None:
        if not columns:
            return
        detail_by_id = {
            column_id: column
            for column in columns
            if (column_id := _row_id(column, "columnId", "id")) is not None
        }
        original = element.get("columns")
        merged: list[object] = []
        seen: set[str] = set()
        if isinstance(original, list):
            for summary in original:
                column_id = (
                    _row_id(summary, "columnId", "id")
                    if isinstance(summary, dict)
                    else str(summary)
                )
                detail = detail_by_id.get(column_id)
                if detail is None:
                    merged.append(summary)
                    continue
                base = dict(summary) if isinstance(summary, dict) else {"columnId": column_id}
                merged.append({**base, **detail})
                seen.add(column_id)
        merged.extend(dict(column) for key, column in detail_by_id.items() if key not in seen)
        element["columns"] = merged

    @classmethod
    def _enrich_elements(
        cls, elements: list[dict], columns: list[dict], queries: list[dict], lineage: list[dict]
    ) -> list[dict]:
        columns_by_element: dict[str, list[dict]] = {}
        lineage_by_element: dict[str, list[dict]] = {}
        queries_by_element: dict[str, dict] = {}
        for column in columns:
            if element_id := _row_id(column, "elementId"):
                columns_by_element.setdefault(element_id, []).append(column)
        for query in queries:
            if element_id := _row_id(query, "elementId"):
                queries_by_element[element_id] = query
        for item in lineage:
            if element_id := _row_id(item, "elementId"):
                lineage_by_element.setdefault(element_id, []).append(item)

        enriched: list[dict] = []
        for raw in elements:
            element = dict(raw)
            element_id = _row_id(element, "elementId", "id")
            if element_id is not None:
                cls._merge_element_columns(element, columns_by_element.get(element_id, []))
                if element_id in queries_by_element:
                    element["generatedSql"] = dict(queries_by_element[element_id])
                if element_id in lineage_by_element:
                    element["lineage"] = [dict(item) for item in lineage_by_element[element_id]]
            enriched.append(element)
        return enriched

    def snapshot(self) -> dict:
        """Acquire a source-faithful, secret-free Sigma snapshot for offline translation."""
        diagnostics: list[dict] = []
        connections = self.list_connections()

        data_models: list[dict] = []
        for raw_model in self.list_data_models():
            model = dict(raw_model)
            data_model_id = _row_id(model, "dataModelId", "id")
            if data_model_id is None:
                raise ValueError("Sigma data model inventory entry omitted dataModelId")
            prefix = f"/v2/dataModels/{data_model_id}"
            model.update(
                {
                    "spec": self.data_model_spec(data_model_id),
                    "sources": self._optional(
                        diagnostics,
                        operation="data_model_sources",
                        endpoint=f"{prefix}/sources",
                        fetch=lambda data_model_id=data_model_id: self.data_model_sources(
                            data_model_id
                        ),
                        default=[],
                    ),
                    "columns": self._optional(
                        diagnostics,
                        operation="data_model_columns",
                        endpoint=f"{prefix}/columns",
                        fetch=lambda data_model_id=data_model_id: self.data_model_columns(
                            data_model_id
                        ),
                        default=[],
                    ),
                    "lineage": self._optional(
                        diagnostics,
                        operation="data_model_lineage",
                        endpoint=f"{prefix}/lineage",
                        fetch=lambda data_model_id=data_model_id: self.data_model_lineage(
                            data_model_id
                        ),
                        default=[],
                    ),
                    "grants": self._optional(
                        diagnostics,
                        operation="data_model_grants",
                        endpoint="/v2/grants",
                        fetch=lambda data_model_id=data_model_id: self.data_model_grants(
                            data_model_id
                        ),
                        default=[],
                    ),
                    "materializationSchedules": self._optional(
                        diagnostics,
                        operation="data_model_materialization_schedules",
                        endpoint=f"{prefix}/materialization-schedules",
                        fetch=lambda data_model_id=data_model_id: (
                            self.data_model_materialization_schedules(data_model_id)
                        ),
                        default=[],
                    ),
                }
            )
            data_models.append(model)

        workbooks: list[dict] = []
        for raw_workbook in self.list_workbooks():
            workbook = dict(raw_workbook)
            workbook_id = _row_id(workbook, "workbookId", "id")
            if workbook_id is None:
                raise ValueError("Sigma workbook inventory entry omitted workbookId")
            prefix = f"/v2/workbooks/{workbook_id}"

            pages: list[dict] = []
            for raw_page in self.workbook_pages(workbook_id):
                page = dict(raw_page)
                page_id = _row_id(page, "pageId", "id")
                if page_id is None:
                    raise ValueError("Sigma workbook page omitted pageId")
                page["elements"] = [
                    dict(element) for element in self.workbook_page_elements(workbook_id, page_id)
                ]
                pages.append(page)

            sources = self._optional(
                diagnostics,
                operation="workbook_sources",
                endpoint=f"{prefix}/sources",
                fetch=lambda workbook_id=workbook_id: self.workbook_sources(workbook_id),
                default=[],
            )
            bulk_elements = self._optional(
                diagnostics,
                operation="workbook_elements",
                endpoint=f"{prefix}/elements",
                fetch=lambda workbook_id=workbook_id: self.workbook_elements(workbook_id),
                default=[],
            )
            raw_elements = self._combine_elements(bulk_elements, pages)

            bulk_columns = self._optional(
                diagnostics,
                operation="workbook_columns",
                endpoint=f"{prefix}/columns",
                fetch=lambda workbook_id=workbook_id: self.workbook_columns(workbook_id),
                default=None,
            )
            columns = list(bulk_columns or [])
            if bulk_columns is None:
                for element in raw_elements:
                    element_id = _row_id(element, "elementId", "id")
                    if element_id is None or str(element.get("type", "")).lower() == "control":
                        continue
                    element_columns = self._optional(
                        diagnostics,
                        operation="workbook_element_columns",
                        endpoint=f"{prefix}/elements/{element_id}/columns",
                        fetch=lambda workbook_id=workbook_id, element_id=element_id: (
                            self.workbook_element_columns(workbook_id, element_id)
                        ),
                        default=[],
                    )
                    columns.extend(
                        {**column, "elementId": column.get("elementId") or element_id}
                        for column in element_columns
                    )
            controls = self._optional(
                diagnostics,
                operation="workbook_controls",
                endpoint=f"{prefix}/controls",
                fetch=lambda workbook_id=workbook_id: self.workbook_controls(workbook_id),
                default=[],
            )
            bulk_queries = self._optional(
                diagnostics,
                operation="workbook_queries",
                endpoint=f"{prefix}/queries",
                fetch=lambda workbook_id=workbook_id: self.workbook_queries(workbook_id),
                default=None,
            )
            queries = list(bulk_queries or [])
            if bulk_queries is None:
                for element in raw_elements:
                    element_id = _row_id(element, "elementId", "id")
                    if element_id is None or str(element.get("type", "")).lower() == "control":
                        continue
                    query = self._optional(
                        diagnostics,
                        operation="workbook_element_query",
                        endpoint=f"{prefix}/elements/{element_id}/query",
                        fetch=lambda workbook_id=workbook_id, element_id=element_id: (
                            self.workbook_element_query(workbook_id, element_id)
                        ),
                        default=None,
                    )
                    if query is not None:
                        queries.append({**query, "elementId": query.get("elementId") or element_id})

            bulk_lineage = self._optional(
                diagnostics,
                operation="workbook_lineage",
                endpoint=f"{prefix}/lineage",
                fetch=lambda workbook_id=workbook_id: self.workbook_lineage(workbook_id),
                default=None,
            )
            lineage = list(bulk_lineage or [])
            if bulk_lineage is None:
                for element in raw_elements:
                    element_id = _row_id(element, "elementId", "id")
                    if element_id is None or str(element.get("type", "")).lower() == "control":
                        continue
                    element_lineage = self._optional(
                        diagnostics,
                        operation="workbook_element_lineage",
                        endpoint=f"{prefix}/lineage/elements/{element_id}",
                        fetch=lambda workbook_id=workbook_id, element_id=element_id: (
                            self.workbook_element_lineage(workbook_id, element_id)
                        ),
                        default=None,
                    )
                    if element_lineage is not None:
                        lineage.append(
                            {
                                **element_lineage,
                                "elementId": element_lineage.get("elementId") or element_id,
                            }
                        )
            grants = self._optional(
                diagnostics,
                operation="workbook_grants",
                endpoint="/v2/grants",
                fetch=lambda workbook_id=workbook_id: self.workbook_grants(workbook_id),
                default=[],
            )
            schedules = self._optional(
                diagnostics,
                operation="workbook_schedules",
                endpoint=f"{prefix}/schedules",
                fetch=lambda workbook_id=workbook_id: self.workbook_schedules(workbook_id),
                default=[],
            )
            materialization_schedules = self._optional(
                diagnostics,
                operation="workbook_materialization_schedules",
                endpoint=f"{prefix}/materialization-schedules",
                fetch=lambda workbook_id=workbook_id: self.workbook_materialization_schedules(
                    workbook_id
                ),
                default=[],
            )

            elements = self._enrich_elements(raw_elements, columns, queries, lineage)
            elements_by_id = {
                element_id: element
                for element in elements
                if (element_id := _row_id(element, "elementId", "id")) is not None
            }
            for page in pages:
                page_elements = []
                for raw_element in page["elements"]:
                    element_id = _row_id(raw_element, "elementId", "id")
                    base = elements_by_id.get(element_id, {})
                    page_elements.append({**base, **raw_element} if base else dict(raw_element))
                page["elements"] = self._enrich_elements(page_elements, columns, queries, lineage)

            if not controls:
                controls = [
                    dict(element)
                    for element in elements
                    if str(element.get("type", "")).lower() == "control"
                ]
            workbook.update(
                {
                    "sources": sources,
                    "pages": pages,
                    "elements": elements,
                    "columns": columns,
                    "controls": controls,
                    "queries": queries,
                    "lineage": lineage,
                    "grants": grants,
                    "schedules": schedules,
                    "materializationSchedules": materialization_schedules,
                }
            )
            workbooks.append(workbook)

        return {
            "connections": connections,
            "dataModels": data_models,
            "workbooks": workbooks,
            "diagnostics": diagnostics,
            "_omnikit_acquisition": {
                "contract": "sigma-api-v2",
                "optional_endpoint_diagnostic_count": len(diagnostics),
            },
        }
