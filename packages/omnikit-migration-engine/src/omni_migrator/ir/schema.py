"""The canonical, tool-agnostic intermediate representation (IR).

Every extractor's only job is to emit a `MigrationBundle`. Everything downstream
(deterministic YAML emit, AI prompting, fidelity reporting) is written once against
this schema. See plan §5 and Appendix A.

Field/enum vocabulary on the *Omni* side lives in `omni_migrator.deterministic.omni_enums`;
the IR itself is intentionally a bit richer (e.g. a `date` data type) and is mapped down
to Omni's vocabulary by the emitter.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

IR_VERSION = "1"

SourceKind = Literal["tableau", "powerbi", "looker", "sigma", "metabase", "other"]
Dialect = Literal[
    "bigquery", "snowflake", "redshift", "postgres", "databricks", "mysql", "other"
]
FieldKind = Literal["dimension", "measure", "calculation", "parameter"]
DataType = Literal["string", "number", "date", "timestamp", "boolean", "duration", "json"]
# Omni-side enums (mirrored in deterministic.omni_enums for validation at emit time):
Aggregate = Literal[
    "sum", "count", "average", "max", "min", "median", "count_distinct",
    "list", "percentile", "sum_distinct", "average_distinct", "none",
]
JoinType = Literal["always_left", "always_inner", "always_right", "always_full"]
RelationshipType = Literal["many_to_one", "one_to_many", "one_to_one", "many_to_many"]
Severity = Literal["info", "warning", "blocker"]
EvidenceRole = Literal["direct", "bundle_input", "derived"]


class UntranslatableNote(BaseModel):
    object: str
    reason: str
    severity: Severity = "warning"
    hint: str | None = None


class SourceEvidence(BaseModel):
    """A content-addressed pointer back to source evidence.

    Extractors may provide an exact ``direct`` locator. The bridge fills any missing
    evidence with ``bundle_input`` references so downstream systems can distinguish
    exact evidence from the set of files that contributed to a parsed bundle.
    """

    artifact_name: str | None = None
    artifact_sha256: str | None = None
    locator: str
    content_sha256: str
    role: EvidenceRole = "direct"


class ConnectionRef(BaseModel):
    source_connection_name: str | None = None
    dialect: Dialect = "other"
    omni_connection_id: str | None = None  # resolved during the Map stage
    database: str | None = None  # resolved Omni connection's catalog/database name (Map stage)


class FieldIR(BaseModel):
    source_id: str | None = None
    source_locator: str | None = None
    evidence: list[SourceEvidence] = Field(default_factory=list)
    name: str  # canonical snake_case; [a-z0-9_], starts with a letter
    source_name: str | None = None
    kind: FieldKind
    data_type: DataType = "string"
    sql: str | None = None  # normalized to ${TABLE}.col / ${field} / ${view.field}
    aggregate: Aggregate | None = None
    value_format: str | None = None  # canonical token; mapped to Omni `format` at emit
    label: str | None = None
    description: str | None = None
    group_label: str | None = None
    hidden: bool = False
    primary_key: bool = False
    timeframes: list[str] | None = None  # source date-part list (dropped on emit; Omni derives)
    filters: dict[str, dict] | None = None  # filtered-measure conditions
    untranslatable: list[UntranslatableNote] = Field(default_factory=list)


class ViewIR(BaseModel):
    source_id: str | None = None
    source_locator: str | None = None
    evidence: list[SourceEvidence] = Field(default_factory=list)
    name: str
    source_table: str | None = None
    schema_name: str | None = None  # "schema" is reserved on pydantic BaseModel
    sql: str | None = None  # derived-table SQL (mutually exclusive with source_table)
    label: str | None = None
    description: str | None = None
    connection: ConnectionRef = Field(default_factory=ConnectionRef)
    fields: list[FieldIR] = Field(default_factory=list)
    untranslatable: list[UntranslatableNote] = Field(default_factory=list)

    @property
    def primary_key_field(self) -> str | None:
        for f in self.fields:
            if f.primary_key:
                return f.name
        return None


class JoinIR(BaseModel):
    source_id: str | None = None
    source_locator: str | None = None
    evidence: list[SourceEvidence] = Field(default_factory=list)
    join_from_view: str
    join_to_view: str
    join_type: JoinType = "always_left"
    relationship_type: RelationshipType = "many_to_one"
    on_sql: str
    reversible: bool = False


class TopicIR(BaseModel):
    source_id: str | None = None
    source_locator: str | None = None
    evidence: list[SourceEvidence] = Field(default_factory=list)
    name: str
    base_view: str
    label: str | None = None
    description: str | None = None
    joins: list[JoinIR] = Field(default_factory=list)


class ModelIR(BaseModel):
    views: list[ViewIR] = Field(default_factory=list)
    topics: list[TopicIR] = Field(default_factory=list)
    untranslatable: list[UntranslatableNote] = Field(default_factory=list)


# ---- dashboards (lighter for now; deterministic dashboard emit is Phase 2) ----

class FilterIR(BaseModel):
    source_id: str | None = None
    native_source_id: str | None = None
    source_locator: str | None = None
    evidence: list[SourceEvidence] = Field(default_factory=list)
    field: str
    operator: str
    values: list[str] = Field(default_factory=list)
    is_negative: bool = False


class QueryIR(BaseModel):
    source_id: str | None = None
    native_source_id: str | None = None
    source_locator: str | None = None
    evidence: list[SourceEvidence] = Field(default_factory=list)
    topic: str
    fields: list[str] = Field(default_factory=list)
    filters: list[FilterIR] = Field(default_factory=list)
    sorts: list[dict] = Field(default_factory=list)
    limit: int | None = None
    pivots: list[str] | None = None


class GridRect(BaseModel):
    x: int = 0
    y: int = 0
    w: int = 12
    h: int = 4


class TileIR(BaseModel):
    source_id: str | None = None
    native_source_id: str | None = None
    source_locator: str | None = None
    evidence: list[SourceEvidence] = Field(default_factory=list)
    kind: Literal["query", "text", "markdown", "image"] = "query"
    title: str | None = None
    query: QueryIR | None = None
    chart_type: str | None = None
    vis_config: dict = Field(default_factory=dict)
    layout: GridRect = Field(default_factory=GridRect)
    untranslatable: list[UntranslatableNote] = Field(default_factory=list)


class DashboardIR(BaseModel):
    source_id: str | None = None
    native_source_id: str | None = None
    selection_aliases: list[str] = Field(default_factory=list)
    source_locator: str | None = None
    evidence: list[SourceEvidence] = Field(default_factory=list)
    name: str
    tiles: list[TileIR] = Field(default_factory=list)
    filters: list[FilterIR] = Field(default_factory=list)
    source_url: str | None = None
    untranslatable: list[UntranslatableNote] = Field(default_factory=list)


class Provenance(BaseModel):
    run_id: str | None = None
    extracted_at: str | None = None
    source_artifact: str | None = None
    tool_version: str = "0.1.0"


class MigrationBundle(BaseModel):
    ir_version: Literal["1"] = IR_VERSION
    source: SourceKind
    provenance: Provenance = Field(default_factory=Provenance)
    model: ModelIR = Field(default_factory=ModelIR)
    dashboards: list[DashboardIR] = Field(default_factory=list)
