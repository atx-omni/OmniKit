"""Tableau extractor: .tds / .twb source evidence -> canonical IR.

Dashboard translation lives in ``dashboard.py``. Tableau publishes an official TWB XSD baseline
for current workbook versions, but XSD validation alone does not prove semantic validity and does
not cover TDS/TDSX or TWBX packaging. This reader therefore treats every artifact as versioned
source evidence, records when official or live validation has not run, and keeps inferred or
unsupported behavior review-visible.

- `<relation type='table'>` -> ViewIR (schema/table from the table attr).
- `<relation type='join'>` -> relationship review evidence. The physical join type and keys are
  retained, but no Omni relationship is emitted because Tableau physical joins do not assert the
  cardinality required by Omni. Logical Tableau relationships are inventoried separately and are
  never collapsed into physical joins.
- `<relation type='text'>` (Custom SQL) -> a derived-table ViewIR (raw SQL verbatim), the same
  treatment as a Metabase native-SQL "Model" (2026-07-10 — previously silently synthesized an
  empty view with zero fields for a 100%-custom-SQL datasource, with no note at all).
- `<column role='dimension'|'measure'>` -> FieldIR; sql resolved to the bare `<remote>`
  column name (Omni has no `${TABLE}` token) via the connection's `<metadata-record>` map.
- Calculated columns (``<calculation class='tableau' formula=...>``): a typed parser accepts only a
  small field/literal/operator subset and a single supported aggregate root. LOD expressions, table
  calculations, parameter-dependent expressions, Tableau functions, and compound aggregates remain
  explicit blockers rather than being regex-translated into different semantics.
"""

from __future__ import annotations

import hashlib
import re
import xml.etree.ElementTree as ET
import zipfile
from dataclasses import dataclass
from pathlib import Path

from omni_migrator.core.archive_safety import (
    read_file_bounded,
    read_zip_member_bounded,
    sha256_file_bounded,
    validate_zip_archive,
)
from omni_migrator.core.contracts import ExtractCtx, ExtractorInput, FileInput
from omni_migrator.ir.identity import content_sha256, stable_source_id
from omni_migrator.ir.schema import (
    AcquisitionDependencyIR,
    AcquisitionEvidenceIR,
    ConnectionRef,
    FieldIR,
    MigrationBundle,
    ModelIR,
    Provenance,
    SemanticRequirementIR,
    SourceEvidence,
    TopicIR,
    UntranslatableNote,
    ViewIR,
)

_LOD = re.compile(r"\{\s*(FIXED|INCLUDE|EXCLUDE)\b", re.IGNORECASE)
_REF = re.compile(r"\[([^\]]+)\]")
_TABLE_CALC = re.compile(
    r"\b(?:LOOKUP|TOTAL|INDEX|FIRST|LAST|SIZE|PREVIOUS_VALUE|"
    r"RUNNING_\w+|WINDOW_\w+|RANK\w*|SCRIPT_\w+)\s*\(",
    re.IGNORECASE,
)
_TABLEAU_PARAMETER_REF = re.compile(r"\[Parameters?\]\s*\.\s*\[[^\]]+\]", re.IGNORECASE)
_AGG_MAP = {
    "sum": "sum",
    "avg": "average",
    "average": "average",
    "count": "count",
    "countd": "count_distinct",
    "count_distinct": "count_distinct",
    "min": "min",
    "max": "max",
    "median": "median",
}
_DTYPE = {"integer": "number", "real": "number", "number": "number",
          "string": "string", "boolean": "boolean", "date": "date", "datetime": "timestamp"}

# dialect inferred from the Tableau connection `class`
_DIALECT = {"snowflake": "snowflake", "bigquery": "bigquery", "redshift": "redshift",
            "postgres": "postgres", "sqlserver": "other", "mysql": "mysql", "databricks": "databricks"}

# a join relation's `join='inner'|'left'|'right'|'full'` attribute -> Omni's JoinType enum
_JOIN_TYPE = {"inner": "always_inner", "left": "always_left", "right": "always_right", "full": "always_full"}

_PACKAGE_XML_MEMBER = {".twbx": ".twb", ".tdsx": ".tds"}
_DIRECT_XML_ROOT = {".twb": "workbook", ".tds": "datasource"}
_PACKAGED_DATA_SUFFIXES = {
    ".hyper", ".tde", ".csv", ".txt", ".tsv", ".xlsx", ".xls", ".mdb", ".accdb",
}
_PACKAGED_LAYOUT_SUFFIXES = {
    ".bmp", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".tif", ".tiff",
}
_LINEAGE_BLOCKING_KINDS = {
    "connection", "include", "lineage", "model", "semantic_model", "source",
}

_FORMULA_TOKEN = re.compile(
    r"""
    (?P<whitespace>\s+)
    |(?P<field>\[[^\]\r\n]+\])
    |(?P<number>(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)
    |(?P<string>'(?:''|[^'])*'|"(?:""|[^"])*")
    |(?P<date>\#[^\#\r\n]+\#)
    |(?P<operator><=|>=|<>|!=|==|[=<>+\-*/%])
    |(?P<lparen>\()
    |(?P<rparen>\))
    |(?P<comma>,)
    |(?P<identifier>[A-Za-z_][A-Za-z0-9_]*)
    """,
    re.VERBOSE,
)


class _FormulaSyntaxError(ValueError):
    pass


class _FormulaTranslationError(ValueError):
    pass


@dataclass(frozen=True)
class _FormulaNode:
    kind: str
    value: str | None = None
    children: tuple["_FormulaNode", ...] = ()


def _formula_tokens(formula: str) -> list[tuple[str, str]]:
    tokens: list[tuple[str, str]] = []
    position = 0
    while position < len(formula):
        match = _FORMULA_TOKEN.match(formula, position)
        if match is None:
            excerpt = formula[position:position + 20]
            raise _FormulaSyntaxError(f"unsupported token near {excerpt!r}")
        position = match.end()
        kind = match.lastgroup
        if kind and kind != "whitespace":
            tokens.append((kind, match.group(kind)))
    return tokens


class _FormulaParser:
    """Typed syntax parser for the deliberately narrow automatic Tableau subset."""

    def __init__(self, formula: str):
        self.tokens = _formula_tokens(formula)
        self.position = 0

    def parse(self) -> _FormulaNode:
        node = self._parse_or()
        if self.position != len(self.tokens):
            raise _FormulaSyntaxError(f"unexpected token {self.tokens[self.position][1]!r}")
        return node

    def _peek(self, kind: str | None = None, value: str | None = None) -> bool:
        if self.position >= len(self.tokens):
            return False
        token_kind, token_value = self.tokens[self.position]
        return (kind is None or token_kind == kind) and (
            value is None or token_value.upper() == value.upper()
        )

    def _take(self, kind: str, value: str | None = None) -> str:
        if not self._peek(kind, value):
            expected = value or kind
            actual = self.tokens[self.position][1] if self.position < len(self.tokens) else "end"
            raise _FormulaSyntaxError(f"expected {expected}, found {actual!r}")
        token_value = self.tokens[self.position][1]
        self.position += 1
        return token_value

    def _parse_or(self) -> _FormulaNode:
        node = self._parse_and()
        while self._peek("identifier", "OR"):
            self._take("identifier", "OR")
            node = _FormulaNode("binary", "OR", (node, self._parse_and()))
        return node

    def _parse_and(self) -> _FormulaNode:
        node = self._parse_comparison()
        while self._peek("identifier", "AND"):
            self._take("identifier", "AND")
            node = _FormulaNode("binary", "AND", (node, self._parse_comparison()))
        return node

    def _parse_comparison(self) -> _FormulaNode:
        node = self._parse_additive()
        if self._peek("operator") and self.tokens[self.position][1] in {
            "=", "==", "!=", "<>", "<", ">", "<=", ">=",
        }:
            operator = self._take("operator")
            node = _FormulaNode("binary", operator, (node, self._parse_additive()))
            if self._peek("operator") and self.tokens[self.position][1] in {
                "=", "==", "!=", "<>", "<", ">", "<=", ">=",
            }:
                raise _FormulaSyntaxError("chained comparisons are not in the automatic subset")
        return node

    def _parse_additive(self) -> _FormulaNode:
        node = self._parse_multiplicative()
        while self._peek("operator") and self.tokens[self.position][1] in {"+", "-"}:
            operator = self._take("operator")
            node = _FormulaNode("binary", operator, (node, self._parse_multiplicative()))
        return node

    def _parse_multiplicative(self) -> _FormulaNode:
        node = self._parse_unary()
        while self._peek("operator") and self.tokens[self.position][1] in {"*", "/", "%"}:
            operator = self._take("operator")
            node = _FormulaNode("binary", operator, (node, self._parse_unary()))
        return node

    def _parse_unary(self) -> _FormulaNode:
        if self._peek("operator") and self.tokens[self.position][1] in {"+", "-"}:
            return _FormulaNode("unary", self._take("operator"), (self._parse_unary(),))
        if self._peek("identifier", "NOT"):
            self._take("identifier", "NOT")
            return _FormulaNode("unary", "NOT", (self._parse_unary(),))
        return self._parse_primary()

    def _parse_primary(self) -> _FormulaNode:
        if self._peek("field"):
            return _FormulaNode("field", _strip_brackets(self._take("field")))
        for kind in ("number", "string", "date"):
            if self._peek(kind):
                return _FormulaNode(kind, self._take(kind))
        if self._peek("identifier"):
            identifier = self._take("identifier")
            if self._peek("lparen"):
                self._take("lparen")
                arguments: list[_FormulaNode] = []
                if not self._peek("rparen"):
                    arguments.append(self._parse_or())
                    while self._peek("comma"):
                        self._take("comma")
                        arguments.append(self._parse_or())
                self._take("rparen")
                return _FormulaNode("call", identifier.upper(), tuple(arguments))
            if identifier.upper() in {"TRUE", "FALSE", "NULL"}:
                return _FormulaNode("literal", identifier.upper())
            raise _FormulaSyntaxError(f"bare identifier {identifier!r} is not supported")
        if self._peek("lparen"):
            self._take("lparen")
            node = self._parse_or()
            self._take("rparen")
            return _FormulaNode("group", children=(node,))
        actual = self.tokens[self.position][1] if self.position < len(self.tokens) else "end"
        raise _FormulaSyntaxError(f"expected an expression, found {actual!r}")


def _formula_nodes(node: _FormulaNode):
    yield node
    for child in node.children:
        yield from _formula_nodes(child)


def _formula_references(formula: str) -> list[str]:
    """Return source references even when the formula is outside the automatic parser subset."""
    return list(dict.fromkeys(_REF.findall(formula)))


def _is_lod_formula(formula: str) -> bool:
    return bool(_LOD.search(formula))


def _is_table_calculation(formula: str) -> bool:
    return bool(_TABLE_CALC.search(formula))


def _snake(text: str) -> str:
    s = re.sub(r"[^0-9a-zA-Z]+", "_", text.strip()).strip("_").lower()
    if s and s[0].isdigit():
        s = f"f_{s}"
    return s or "field"


def _strip_brackets(s: str) -> str:
    return s.strip().strip("[]")


def _parse_table_attr(table: str | None):
    """`[PUBLIC].[ORDERS]` -> ('PUBLIC', 'ORDERS'); single part -> (None, part)."""
    if not table:
        return None, None
    parts = [_strip_brackets(p) for p in re.findall(r"\[[^\]]*\]|[^.\[\]]+", table) if p.strip(". ")]
    parts = [p for p in parts if p]
    if len(parts) >= 2:
        return parts[-2], parts[-1]
    return None, (parts[0] if parts else None)


def _metadata_map(conn: ET.Element) -> dict[str, str]:
    """local-name (no brackets) -> remote (physical DB) column name."""
    out: dict[str, str] = {}
    for rec in conn.iter("metadata-record"):
        if rec.get("class") != "column":
            continue
        local = rec.findtext("local-name")
        remote = rec.findtext("remote-name")
        if local and remote:
            out[_strip_brackets(local)] = _strip_brackets(remote)
    return out


def _metadata_parent_map(conn: ET.Element) -> dict[str, str]:
    """Local field name -> relation name for joined Tableau datasources."""
    out: dict[str, str] = {}
    for rec in conn.iter("metadata-record"):
        if rec.get("class") != "column":
            continue
        local = rec.findtext("local-name")
        parent = rec.findtext("parent-name")
        if local and parent:
            out[_strip_brackets(local)] = _strip_brackets(parent)
    return out


def _datatype(col: ET.Element) -> str:
    return _DTYPE.get((col.get("datatype") or "").lower(), "string")


class _Resolver:
    """Resolves parsed field nodes to bare physical column names and source data types.

    Omni has no `${TABLE}` token (verified against `docs.omni.co/modeling` and the Omni
    compiler source) — a view's `sql:` is scoped to its own table, so physical columns are
    referenced bare; `${...}` is reserved for *field* references, not raw columns.
    """

    def __init__(self, meta: dict[str, str]):
        self.meta = meta
        self.ref_sql: dict[str, tuple[str, str]] = {}

    def register_physical(
        self,
        key_caption: str | None,
        key_name: str | None,
        remote: str | None,
        data_type: str,
    ) -> None:
        for k in (key_caption, key_name):
            if k and remote:
                self.ref_sql[k] = (remote, data_type)

    def remote_for(self, name_no_brackets: str, caption: str | None) -> str | None:
        return self.meta.get(name_no_brackets) or (self.meta.get(caption) if caption else None)

    def resolve(self, reference: str) -> tuple[str, str] | None:
        return self.ref_sql.get(reference)


def _render_formula(node: _FormulaNode, resolver: _Resolver) -> tuple[str, str]:
    if node.kind == "field":
        resolved = resolver.resolve(node.value or "")
        if resolved is None:
            raise _FormulaTranslationError(f"unresolved reference {node.value!r}")
        return resolved
    if node.kind == "number":
        return node.value or "0", "number"
    if node.kind == "string":
        return node.value or "''", "string"
    if node.kind == "date":
        raise _FormulaTranslationError("Tableau date literals require dialect-aware translation")
    if node.kind == "literal":
        literal_type = "boolean" if node.value in {"TRUE", "FALSE"} else "null"
        return node.value or "NULL", literal_type
    if node.kind == "group":
        sql, data_type = _render_formula(node.children[0], resolver)
        return f"({sql})", data_type
    if node.kind == "unary":
        sql, data_type = _render_formula(node.children[0], resolver)
        if node.value == "NOT":
            if data_type != "boolean":
                raise _FormulaTranslationError("NOT requires a boolean operand")
            return f"NOT {sql}", "boolean"
        if data_type != "number":
            raise _FormulaTranslationError(f"{node.value} requires a numeric operand")
        return f"{node.value}{sql}", "number"
    if node.kind == "binary":
        left_sql, left_type = _render_formula(node.children[0], resolver)
        right_sql, right_type = _render_formula(node.children[1], resolver)
        operator = node.value or ""
        if operator in {"AND", "OR"}:
            if left_type != "boolean" or right_type != "boolean":
                raise _FormulaTranslationError(f"{operator} requires boolean operands")
            return f"{left_sql} {operator} {right_sql}", "boolean"
        if operator in {"+", "-", "*", "/", "%"}:
            if left_type != "number" or right_type != "number":
                raise _FormulaTranslationError(
                    f"{operator} is only automatic for numeric operands; Tableau type is ambiguous"
                )
            return f"{left_sql} {operator} {right_sql}", "number"
        if "null" in {left_type, right_type}:
            raise _FormulaTranslationError("NULL comparisons require Tableau-specific null semantics")
        if left_type != right_type:
            raise _FormulaTranslationError(
                f"comparison mixes {left_type} and {right_type} operands"
            )
        normalized_operator = "=" if operator == "==" else ("!=" if operator == "<>" else operator)
        return f"{left_sql} {normalized_operator} {right_sql}", "boolean"
    if node.kind == "call":
        raise _FormulaTranslationError(f"Tableau function {node.value} is not in the automatic subset")
    raise _FormulaTranslationError(f"unsupported parsed node {node.kind!r}")


def _calc_field(
    col: ET.Element,
    formula: str,
    role: str,
    resolver: _Resolver,
    parameter_names: set[str] | None = None,
):
    """Classify a calculated field -> (FieldIR | None, UntranslatableNote | None)."""
    caption = col.get("caption") or _strip_brackets(col.get("name") or "calc")
    name = _snake(caption)
    obj = f"calculated field {caption}"
    parameter_names = parameter_names or set()

    if _is_lod_formula(formula):
        return None, UntranslatableNote(
            object=obj,
            severity="blocker",
            hint=formula,
            reason=(
                "Level-of-Detail expression is unsupported automatically; FIXED, INCLUDE, and "
                "EXCLUDE depend on Tableau view and filter granularity and require an explicit "
                "target design."
            ),
        )
    if _is_table_calculation(formula):
        return None, UntranslatableNote(
            object=obj,
            severity="blocker",
            hint=formula,
            reason=(
                "Table calculation is unsupported automatically; partitioning, addressing, and "
                "worksheet context must be reviewed explicitly."
            ),
        )

    parameter_refs = sorted(set(_formula_references(formula)) & parameter_names)
    if parameter_refs:
        return None, UntranslatableNote(
            object=obj,
            severity="blocker",
            hint=formula,
            reason=(
                "Parameter-dependent calculation is not emitted automatically; preserve and wire "
                f"the workbook parameter behavior explicitly ({', '.join(parameter_refs)})."
            ),
        )

    try:
        parsed = _FormulaParser(formula).parse()
    except _FormulaSyntaxError as exc:
        return None, UntranslatableNote(
            object=obj,
            severity="blocker",
            hint=formula,
            reason=f"Calculation is outside the typed automatic subset: {exc}.",
        )

    calls = [node for node in _formula_nodes(parsed) if node.kind == "call"]
    if parsed.kind == "call" and (parsed.value or "").lower() in _AGG_MAP:
        function = (parsed.value or "").lower()
        if len(parsed.children) != 1 or any(
            node.kind == "call" for node in _formula_nodes(parsed.children[0])
        ):
            return None, UntranslatableNote(
                object=obj,
                severity="blocker",
                hint=formula,
                reason="Nested or multi-argument aggregate requires an explicit reviewed rewrite.",
            )
        try:
            sql, inner_type = _render_formula(parsed.children[0], resolver)
        except _FormulaTranslationError as exc:
            return None, UntranslatableNote(
                object=obj,
                severity="blocker",
                hint=formula,
                reason=f"Aggregate calculation is not emitted automatically: {exc}.",
            )
        if function not in {"count", "countd", "count_distinct"} and inner_type != "number":
            return None, UntranslatableNote(
                object=obj,
                severity="blocker",
                hint=formula,
                reason=f"{parsed.value} is only automatic for a numeric typed expression.",
            )
        return FieldIR(
            name=name,
            source_name=caption,
            kind="measure",
            data_type="number",
            sql=sql,
            aggregate=_AGG_MAP[function],
        ), None

    if calls:
        names = sorted({node.value or "unknown" for node in calls})
        if any((node.value or "").lower() in _AGG_MAP for node in calls):
            reason = (
                "Compound aggregate calculation is unsupported automatically; multiple aggregate "
                "roots require a reviewed compound-measure or query-view design"
            )
        else:
            reason = "Tableau function semantics require a typed mapping before automatic emission"
        return None, UntranslatableNote(
            object=obj,
            severity="blocker",
            hint=formula,
            reason=f"{reason} ({', '.join(names)}).",
        )

    try:
        sql, result_type = _render_formula(parsed, resolver)
    except _FormulaTranslationError as exc:
        return None, UntranslatableNote(
            object=obj,
            severity="blocker",
            hint=formula,
            reason=f"Calculation is not emitted automatically: {exc}.",
        )

    declared_type = _datatype(col)
    if declared_type != result_type:
        return None, UntranslatableNote(
            object=obj,
            severity="blocker",
            hint=formula,
            reason=(
                f"Typed parser produced {result_type}, but Tableau declares {declared_type}; "
                "the mismatch requires review."
            ),
        )
    return FieldIR(
        name=name,
        source_name=caption,
        # A row-level expression remains a dimension-like semantic field. Tableau may aggregate
        # its worksheet instance later, but this formula itself does not establish an aggregate.
        kind="dimension",
        data_type=declared_type,
        sql=sql,
    ), None


def _relation_sql_text(rel: ET.Element) -> str:
    """Return custom SQL exactly as decoded by the XML parser, without semantic rewrites."""
    return (rel.text or "").strip()


def _join_clause_edges(rel: ET.Element) -> list[tuple[str, str, str, str]]:
    """A join relation's `<clause type='join'>` -> `[(table_a, col_a, table_b, col_b), ...]`
    for every `=` equality found (top-level or AND-nested, for a composite join key) — e.g.
    `[Orders].[Customer_Id] = [Customers].[Id]`. Both observed operand encodings are parsed, but
    the XML shape is an unsupported Tableau contract and remains fixture-verified only."""
    edges: list[tuple[str, str, str, str]] = []
    clause = rel.find("clause")
    if clause is None or clause.get("type") != "join":
        return edges
    for eq in clause.iter("expression"):
        if eq.get("op") != "=":
            continue
        l_ref, r_ref = eq.get("left"), eq.get("right")
        if not l_ref or not r_ref:
            operands = list(eq)
            if len(operands) != 2:
                continue
            l_ref, r_ref = operands[0].get("op"), operands[1].get("op")
        if not l_ref or not r_ref:
            continue
        l_table, l_col = _parse_table_attr(l_ref)
        r_table, r_col = _parse_table_attr(r_ref)
        if l_table and l_col and r_table and r_col:
            edges.append((l_table, l_col, r_table, r_col))
    return edges


def _join_relation_edges(rel: ET.Element) -> list[tuple[str, str, str, str, str | None]]:
    """A `<relation type='join'>` -> `[(from_ref, from_col, to_ref, to_col, join_attr), ...]` —
    only for the unambiguous case where both direct children are plain table/custom-SQL
    relations, never another nested join. Chained/multi-way joins are left flagged for a human
    rather than guessed at (same "translate the unambiguous, flag the rest" discipline as
    everywhere else in this extractor)."""
    children = [c for c in rel if c.tag == "relation"]
    if len(children) != 2 or any(c.get("type") not in ("table", "text") for c in children):
        return []
    join_attr = rel.get("join")
    return [(*edge, join_attr) for edge in _join_clause_edges(rel)]


def _identity(value, kind: str, locator: str):
    value.source_locator = locator
    value.source_id = stable_source_id("tableau", kind, locator)
    return value


def _local_tag(element: ET.Element) -> str:
    return element.tag.rsplit("}", 1)[-1].lower()


def _xml_key(element: ET.Element, fallback: str) -> str:
    for attribute in ("name", "caption", "formatted-name", "table", "id"):
        if element.get(attribute):
            return str(element.get(attribute))
    digest = hashlib.sha256(ET.tostring(element, encoding="utf-8")).hexdigest()[:12]
    return f"{fallback}:{digest}"


def _embedded_datasources(root: ET.Element) -> list[ET.Element]:
    if _local_tag(root) == "datasource":
        return [root]
    return list(root.findall("./datasources/datasource"))


def _official_twb_xsd_available(root: ET.Element) -> bool:
    if _local_tag(root) != "workbook":
        return False
    version = (root.get("version") or root.get("original-version") or "").strip()
    return version.startswith(("26.1", "26.2", "2026.1", "2026.2"))


def _default_aggregation(col: ET.Element) -> tuple[str | None, str | None]:
    source_value = col.get("default-aggregation") or col.get("aggregation")
    if not source_value:
        return "sum", None
    normalized = source_value.strip().lower().replace(" ", "_")
    return _AGG_MAP.get(normalized), source_value


def _calculation_requirement(
    *,
    locator: str,
    caption: str,
    formula: str,
    note: UntranslatableNote,
) -> SemanticRequirementIR:
    return _identity(
        SemanticRequirementIR(
            object_type="query_validation",
            name=f"Tableau calculation {caption}",
            support_outcome="unsupported",
            reason=note.reason,
            dependencies=_formula_references(formula),
            config={
                "artifact_class": "calculation",
                "formula_sha256": hashlib.sha256(formula.encode("utf-8")).hexdigest(),
                "source_formula_preserved_in_note": True,
                "scope": "data_source",
            },
        ),
        "semantic_requirement",
        f"{locator}/review",
    )


def _datasource(
    ds: ET.Element,
    default_schema: str | None,
    *,
    artifact_key: str = "tableau-artifact",
    requirements: list[SemanticRequirementIR] | None = None,
    parameter_names: set[str] | None = None,
):
    requirements = requirements if requirements is not None else []
    parameter_names = parameter_names or set()
    conn = ds.find("connection")
    meta = _metadata_map(conn) if conn is not None else {}
    field_parents = _metadata_parent_map(conn) if conn is not None else {}
    cls = (conn.get("class") if conn is not None else None) or ""
    dialect = _DIALECT.get(cls.lower(), "other")
    datasource_key = _xml_key(ds, "datasource")
    datasource_locator = f"artifact:{artifact_key}/datasource:{datasource_key}"

    # tables (and custom-SQL relations) -> views
    views: dict[str, ViewIR] = {}
    table_views: list[str] = []
    view_by_relation_name: dict[str, str] = {}
    if conn is not None:
        for rel in conn.iter("relation"):
            if rel.get("type") == "table":
                schema, table = _parse_table_attr(rel.get("table"))
                vname = _snake(rel.get("name") or table or "view")
                relation_locator = f"{datasource_locator}/relation:{_xml_key(rel, 'table')}"
                view = _identity(
                    ViewIR(
                        name=vname,
                        schema_name=schema or default_schema,
                        source_table=table,
                        connection=ConnectionRef(source_connection_name=cls, dialect=dialect),
                    ),
                    "view",
                    relation_locator,
                )
            elif rel.get("type") == "text":
                vname = _snake(rel.get("name") or "custom_sql")
                relation_locator = f"{datasource_locator}/relation:{_xml_key(rel, 'custom-sql')}"
                raw_sql = _relation_sql_text(rel)
                has_parameter = bool(_TABLEAU_PARAMETER_REF.search(raw_sql))
                view = _identity(
                    ViewIR(
                        name=vname,
                        sql=raw_sql,
                        connection=ConnectionRef(source_connection_name=cls, dialect=dialect),
                    ),
                    "view",
                    relation_locator,
                )
                review_reason = (
                    "Custom SQL contains a Tableau parameter reference and is unsupported for "
                    "automatic target emission. The SQL is preserved verbatim as source evidence."
                    if has_parameter
                    else "Custom SQL is preserved verbatim, but portability, source execution, and "
                    "upstream lineage are not established; an explicit reviewed placement is required."
                )
                view.untranslatable.append(UntranslatableNote(
                    object=f"custom SQL {vname}",
                    severity="blocker",
                    reason=review_reason,
                    hint=f"sha256:{hashlib.sha256(raw_sql.encode('utf-8')).hexdigest()}",
                ))
                requirements.append(_identity(
                    SemanticRequirementIR(
                        object_type="derived_table",
                        name=f"Tableau custom SQL {datasource_key}.{vname}",
                        support_outcome="unsupported" if has_parameter else "decision_required",
                        reason=review_reason,
                        target_file_hint=f"{vname}.view",
                        config={
                            "dialect": dialect,
                            "has_tableau_parameter_reference": has_parameter,
                            "lineage_complete": False,
                            "sql_preserved_verbatim": True,
                            "sql_sha256": hashlib.sha256(raw_sql.encode("utf-8")).hexdigest(),
                        },
                    ),
                    "semantic_requirement",
                    f"{relation_locator}/custom-sql-review",
                ))
            else:
                continue
            if vname in views:
                suffix = hashlib.sha256(relation_locator.encode("utf-8")).hexdigest()[:8]
                original_name = vname
                vname = f"{vname}_{suffix}"
                view.name = vname
                view.untranslatable.append(UntranslatableNote(
                    object=f"relation {original_name}",
                    severity="blocker",
                    reason=(
                        "Duplicate canonical relation name required a deterministic suffix; target "
                        "naming and references require review."
                    ),
                ))
            views[vname] = view
            view_by_relation_name[rel.get("name") or ""] = vname
            table_views.append(vname)
    if not views:  # datasource with no explicit relation: synthesize one view
        vname = _snake(ds.get("formatted-name") or ds.get("name") or "extract")
        synthetic_locator = f"{datasource_locator}/synthetic-view:no-relation"
        views[vname] = _identity(
            ViewIR(
                name=vname,
                connection=ConnectionRef(dialect=dialect),
                untranslatable=[UntranslatableNote(
                    object=f"datasource {datasource_key}",
                    severity="blocker",
                    reason=(
                        "No physical or custom-SQL relation was present. A synthetic view identity "
                        "was created for inventory only; lineage and target table placement are missing."
                    ),
                )],
            ),
            "view",
            synthetic_locator,
        )
        requirements.append(_identity(
            SemanticRequirementIR(
                object_type="lineage",
                name=f"Tableau datasource {datasource_key} missing relation",
                support_outcome="manual",
                reason=(
                    "A source relation is required before this synthetic inventory view can become "
                    "an Omni view."
                ),
                dependencies=[datasource_key],
                config={"synthetic_identity_reason": "datasource has no relation"},
            ),
            "semantic_requirement",
            f"{synthetic_locator}/lineage-review",
        ))
        table_views.append(vname)

    primary_view = views[table_views[0]]
    resolver = _Resolver(meta)
    # Attached straight to `primary_view.untranslatable` (not a model-level list) — the
    # per-file AI seed prompt and the `ai_policy="notes"` routing decision both key off
    # `view.untranslatable`, so a note that only lived at the model level would silently
    # never reach the AI at all.

    # first pass: register physical columns so calcs can resolve refs
    plain_cols, calc_cols = [], []
    for col in ds.findall("column"):
        calc = col.find("calculation")
        if calc is not None and calc.get("formula"):
            if (calc.get("class") or "").lower() in {"set", "combined-set"}:
                # Set definitions are inventoried by `_set_requirements`; treating their
                # predicates as ordinary boolean fields would erase membership semantics.
                continue
            calc_cols.append((col, calc.get("formula")))
        else:
            caption = col.get("caption") or _strip_brackets(col.get("name") or "")
            name_nb = _strip_brackets(col.get("name") or "")
            remote = resolver.remote_for(name_nb, caption)
            resolver.register_physical(caption, name_nb, remote, _datatype(col))
            plain_cols.append((col, caption, name_nb, remote))

    # plain columns -> dimensions / measures
    for col, caption, name_nb, remote in plain_cols:
        if caption.startswith("Number of Records") or name_nb == "Number of Records":
            continue
        role = (col.get("role") or "dimension").lower()
        sql = remote  # bare column name (Omni has no ${TABLE} token)
        field_name = _snake(caption)
        parent_ref = field_parents.get(name_nb) or field_parents.get(caption)
        destination = views.get(view_by_relation_name.get(parent_ref, ""), primary_view)
        field_locator = f"{datasource_locator}/column:{col.get('name') or caption}"
        if remote is None:
            destination.untranslatable.append(UntranslatableNote(
                object=f"field {caption}",
                severity="blocker",
                reason=(
                    "The Tableau field has no resolved physical remote column in the embedded "
                    "metadata; SQL remains unset instead of guessing from the caption."
                ),
            ))
        if len(views) > 1 and not parent_ref:
            destination.untranslatable.append(UntranslatableNote(
                object=f"field {caption}",
                severity="blocker",
                reason=(
                    "The joined datasource did not identify this field's parent relation; it is "
                    "attached to the base view for inventory only and needs lineage review."
                ),
            ))
        if role == "measure":
            aggregate, source_aggregate = _default_aggregation(col)
            destination.fields.append(_identity(
                FieldIR(
                    name=field_name,
                    source_name=caption,
                    kind="measure",
                    data_type="number",
                    sql=sql,
                    aggregate=aggregate,
                ),
                "field",
                field_locator,
            ))
            if source_aggregate and aggregate is None:
                destination.untranslatable.append(UntranslatableNote(
                    object=f"measure {caption}",
                    severity="blocker",
                    reason=(
                        f"Tableau default aggregation {source_aggregate!r} is not mapped; no target "
                        "aggregation was inferred."
                    ),
                ))
            elif source_aggregate is None:
                destination.untranslatable.append(UntranslatableNote(
                    object=f"measure {caption}",
                    severity="info",
                    reason=(
                        "No field-specific default aggregation was present in the artifact; used "
                        "Tableau's documented SUM default and retained this review note."
                    ),
                ))
        else:
            destination.fields.append(_identity(
                FieldIR(
                    name=field_name,
                    source_name=caption,
                    kind="dimension",
                    data_type=_datatype(col),
                    sql=sql,
                ),
                "field",
                field_locator,
            )
            )

    # calculated columns -> resolved
    for col, formula in calc_cols:
        field, note = _calc_field(
            col,
            formula,
            (col.get("role") or "dimension").lower(),
            resolver,
            parameter_names,
        )
        calc_locator = f"{datasource_locator}/column:{col.get('name') or _xml_key(col, 'calc')}"
        if field:
            _identity(field, "field", calc_locator)
            primary_view.fields.append(field)
        if note:
            primary_view.untranslatable.append(note)
            requirements.append(_calculation_requirement(
                locator=calc_locator,
                caption=col.get("caption") or _strip_brackets(col.get("name") or "calculation"),
                formula=formula,
                note=note,
            ))

    # joins between table-views -> a topic, from real <relation type='join'> clauses (previously
    # this always produced an empty topic with zero joins, silently, for any multi-table
    # datasource — the join clause was never actually read).
    topic = None
    if len(table_views) > 1 and conn is not None:
        topic_locator = f"{datasource_locator}/topic:{primary_view.name}"
        topic = _identity(
            TopicIR(name=primary_view.name, base_view=primary_view.name),
            "topic",
            topic_locator,
        )
        for rel in conn.iter("relation"):
            if rel.get("type") != "join":
                continue
            edges = _join_relation_edges(rel)
            if not edges:
                primary_view.untranslatable.append(UntranslatableNote(
                    object="join", severity="blocker",
                    reason="Could not resolve a simple 2-relation join condition (a chained/"
                    "multi-way join, or an unrecognized <clause> shape) — needs manual/AI join "
                    "wiring, not guessed.",
                ))
                continue
            for from_ref, from_col, to_ref, to_col, join_attr in edges:
                if join_attr not in _JOIN_TYPE:
                    primary_view.untranslatable.append(UntranslatableNote(
                        object="join",
                        severity="blocker",
                        hint=str(join_attr),
                        reason=(
                            "Join type is missing or unsupported in the source artifact; the join "
                            "was not emitted instead of defaulting to a different type."
                        ),
                    ))
                    continue
                from_view, to_view = view_by_relation_name.get(from_ref), view_by_relation_name.get(to_ref)
                if not from_view or not to_view:
                    primary_view.untranslatable.append(UntranslatableNote(
                        object="join", severity="blocker",
                        hint=f"{from_ref}.{from_col} = {to_ref}.{to_col}",
                        reason="Join clause referenced a relation this pass didn't resolve to "
                        "a view — needs manual/AI join wiring.",
                    ))
                    continue
                from_field, to_field = _snake(from_col), _snake(to_col)
                # The join key needs to exist as a dimension on its view to be a usable Omni
                # join, even when it was never one of the datasource's projected <column> fields.
                for view_name, col_name, field_name in (
                    (from_view, from_col, from_field), (to_view, to_col, to_field),
                ):
                    view = views[view_name]
                    if not any(f.name == field_name for f in view.fields):
                        key_locator = f"{views[view_name].source_locator}/join-key:{col_name}"
                        view.fields.append(_identity(
                            FieldIR(
                                name=field_name,
                                source_name=col_name,
                                kind="dimension",
                                sql=meta.get(col_name, col_name),
                            ),
                            "field",
                            key_locator,
                        ))
                join_locator = (
                    f"{topic_locator}/join:{from_ref}.{from_col}->{to_ref}.{to_col}"
                )
                primary_view.untranslatable.append(UntranslatableNote(
                    object=f"join {from_view}.{from_field} -> {to_view}.{to_field}",
                    severity="blocker",
                    reason=(
                        "Physical join keys and type were inventoried, but no Omni relationship "
                        "was emitted because the Tableau join does not assert target cardinality. "
                        "Choose relationship direction/cardinality after source-data validation."
                    ),
                ))
                requirements.append(_identity(
                    SemanticRequirementIR(
                        object_type="lineage",
                        name=f"Tableau join {from_view} to {to_view}",
                        support_outcome="decision_required",
                        reason=(
                            "Join keys and type were inventoried, but cardinality and live source "
                            "behavior require explicit validation."
                        ),
                        dependencies=[from_view, to_view],
                        config={
                            "source_join_type": join_attr,
                            "proposed_omni_join_type": _JOIN_TYPE[join_attr],
                            "from_view": from_view,
                            "from_field": from_field,
                            "to_view": to_view,
                            "to_field": to_field,
                            "on_sql_evidence": (
                                f"${{{from_view}.{from_field}}} = "
                                f"${{{to_view}.{to_field}}}"
                            ),
                            "relationship_type": None,
                            "cardinality_is_source_asserted": False,
                            "automatic_translation": False,
                        },
                    ),
                    "semantic_requirement",
                    f"{join_locator}/cardinality-review",
                ))
    return list(views.values()), topic


def _parameter_requirements(
    root: ET.Element,
    artifact_key: str,
) -> tuple[set[str], list[SemanticRequirementIR]]:
    parameter_names: set[str] = set()
    requirements: list[SemanticRequirementIR] = []
    seen: set[int] = set()
    for datasource in root.iter("datasource"):
        is_parameter_source = (datasource.get("name") or "").lower() == "parameters"
        for column in datasource.findall("column"):
            if not is_parameter_source and not column.get("param-domain-type"):
                continue
            if id(column) in seen:
                continue
            seen.add(id(column))
            source_name = _strip_brackets(column.get("name") or "")
            caption = column.get("caption") or source_name or "parameter"
            parameter_names.update(item for item in (source_name, caption) if item)
            domain_type = column.get("param-domain-type") or "unknown"
            members = [
                {
                    "value": member.get("value"),
                    "alias": member.get("alias"),
                }
                for member in column.findall(".//member")
            ]
            range_element = column.find("range")
            range_config = dict(sorted(range_element.attrib.items())) if range_element is not None else {}
            locator = f"artifact:{artifact_key}/parameter:{column.get('name') or caption}"
            requirements.append(_identity(
                SemanticRequirementIR(
                    object_type="parameter",
                    name=f"Tableau parameter {caption}",
                    support_outcome="decision_required",
                    reason=(
                        "Tableau parameters are workbook variables that may affect calculations, "
                        "filters, reference lines, custom SQL, and actions. Definition evidence is "
                        "preserved, but target control and binding behavior require explicit review."
                    ),
                    dependencies=[source_name] if source_name else [],
                    config={
                        "scope": "workbook",
                        "source_name": source_name,
                        "data_type": _datatype(column),
                        "current_value": column.get("value"),
                        "domain_type": domain_type,
                        "members": members,
                        "range": range_config,
                    },
                ),
                "semantic_requirement",
                locator,
            ))
    return parameter_names, requirements


def _set_requirements(
    root: ET.Element,
    artifact_key: str,
) -> tuple[set[int], list[SemanticRequirementIR]]:
    """Inventory set/group evidence without interpreting membership or interaction behavior."""
    action_elements = {
        id(element)
        for action in root.iter("action")
        for element in action.iter()
    }
    candidates: list[tuple[ET.Element, str]] = []
    set_calculation_ids: set[int] = set()
    for column in root.iter("column"):
        calculation = column.find("calculation")
        calculation_class = (
            (calculation.get("class") if calculation is not None else None) or ""
        ).lower()
        if calculation_class in {"set", "combined-set"}:
            candidates.append((column, calculation_class))
            set_calculation_ids.add(id(column))
    for element in root.iter():
        tag = _local_tag(element)
        if id(element) in action_elements or tag not in {
            "combined-set", "group", "groupfilter", "set",
        }:
            continue
        candidates.append((element, tag))

    requirements: list[SemanticRequirementIR] = []
    seen: set[int] = set()
    for index, (element, source_kind) in enumerate(candidates):
        if id(element) in seen:
            continue
        seen.add(id(element))
        name = (
            element.get("caption")
            or _strip_brackets(element.get("name") or "")
            or f"unnamed {source_kind} {index + 1}"
        )
        definition = ET.tostring(element, encoding="utf-8")
        locator = f"artifact:{artifact_key}/set:{_xml_key(element, source_kind)}:{index}"
        requirements.append(_identity(
            SemanticRequirementIR(
                object_type="query_validation",
                name=f"Tableau set/group {name}",
                support_outcome="unsupported",
                reason=(
                    "Tableau set/group membership, combination rules, and action-driven state are "
                    "preserved as evidence only. They require an explicit Omni field, filter, or "
                    "interaction design and are not emitted automatically."
                ),
                dependencies=[name],
                config={
                    "artifact_class": "set_or_group",
                    "source_element": source_kind,
                    "definition_sha256": hashlib.sha256(definition).hexdigest(),
                    "source_definition_preserved": True,
                    "automatic_translation": False,
                },
            ),
            "semantic_requirement",
            locator,
        ))
    return set_calculation_ids, requirements


def _logical_relationship_elements(root: ET.Element) -> list[ET.Element]:
    relationships = [
        element for element in root.iter() if _local_tag(element) == "relationship"
    ]
    if relationships:
        return relationships
    # Some workbook generations retain an object graph while omitting a leaf relationship
    # node. Preserve that as unresolved graph evidence instead of treating it as no lineage.
    return [
        element for element in root.iter() if _local_tag(element) in {
            "object-graph", "object-model",
        }
    ]


def _logical_relationship_requirements(
    root: ET.Element,
    artifact_key: str,
) -> list[SemanticRequirementIR]:
    requirements: list[SemanticRequirementIR] = []
    for index, relationship in enumerate(_logical_relationship_elements(root)):
        name = relationship.get("name") or relationship.get("id") or f"relationship {index + 1}"
        definition = ET.tostring(relationship, encoding="utf-8")
        locator = (
            f"artifact:{artifact_key}/logical-relationship:"
            f"{_xml_key(relationship, 'relationship')}:{index}"
        )
        requirements.append(_identity(
            SemanticRequirementIR(
                object_type="lineage",
                name=f"Tableau logical relationship {name}",
                support_outcome="decision_required",
                reason=(
                    "Tableau logical relationships preserve table grain and choose joins from "
                    "worksheet context. The source graph is inventoried, but it is not flattened "
                    "into an Omni physical join or assigned guessed cardinality."
                ),
                dependencies=[name],
                config={
                    "artifact_class": "logical_relationship",
                    "source_element": _local_tag(relationship),
                    "definition_sha256": hashlib.sha256(definition).hexdigest(),
                    "source_definition_preserved": True,
                    "cardinality_inferred": False,
                    "automatic_translation": False,
                },
            ),
            "semantic_requirement",
            locator,
        ))
    return requirements


def _connection_requirements(
    root: ET.Element,
    artifact_key: str,
    members: tuple[str, ...],
) -> list[SemanticRequirementIR]:
    datasources = _embedded_datasources(root)
    extract_members = sorted(
        member for member in members
        if Path(member).suffix.lower() in {".hyper", ".tde"}
    )
    requirements: list[SemanticRequirementIR] = []
    for index, datasource in enumerate(datasources):
        name = datasource.get("caption") or datasource.get("name") or f"datasource {index + 1}"
        connections = list(datasource.findall(".//connection"))
        connection_classes = sorted({
            (connection.get("class") or "unknown").lower()
            for connection in connections
        })
        has_extract_element = datasource.find(".//extract") is not None
        has_explicit_extract_connection = bool(
            {"dataengine", "hyper"} & set(connection_classes)
        )
        if has_extract_element or has_explicit_extract_connection:
            mode = "extract"
            mode_evidence = "datasource_extract_definition"
        elif extract_members and len(datasources) == 1:
            mode = "extract"
            mode_evidence = "single_datasource_packaged_extract"
        elif extract_members:
            mode = "unknown"
            mode_evidence = "packaged_extract_not_scoped_to_datasource"
        elif connections and "sqlproxy" not in connection_classes:
            mode = "live"
            mode_evidence = "direct_connection_without_extract"
        elif connections:
            mode = "published_or_external"
            mode_evidence = "tableau_server_connection"
        else:
            mode = "unknown"
            mode_evidence = "missing_embedded_connection"
        support_outcome = "decision_required" if mode in {"live", "extract"} else "manual"
        locator = f"artifact:{artifact_key}/connection:{_xml_key(datasource, 'datasource')}"
        requirements.append(_identity(
            SemanticRequirementIR(
                object_type="lineage",
                name=f"Tableau connection mode {name}",
                support_outcome=support_outcome,
                reason=(
                    "The artifact establishes connection-mode evidence but does not establish "
                    "target credentials, network reachability, refresh ownership, or source-query "
                    "equivalence. Those checks remain controlled deployment work."
                ),
                dependencies=[name],
                config={
                    "artifact_class": "connection",
                    "connection_classes": connection_classes,
                    "connection_mode": mode,
                    "mode_evidence": mode_evidence,
                    "packaged_extract_members": extract_members,
                    "credentials_preserved": False,
                    "source_query_validated": False,
                },
            ),
            "semantic_requirement",
            locator,
        ))
    return requirements


def _workbook_lineage_requirement(
    root: ET.Element,
    artifact_key: str,
) -> SemanticRequirementIR | None:
    if root.tag == "datasource":
        return None
    datasource_names = sorted({
        datasource.get("name") or datasource.get("caption") or _xml_key(datasource, "datasource")
        for datasource in root.findall("./datasources/datasource")
    })
    worksheet_names = sorted({
        worksheet.get("name") or _xml_key(worksheet, "worksheet")
        for worksheet in root.findall("./worksheets/worksheet")
    })
    dashboard_names = sorted({
        dashboard.get("name") or _xml_key(dashboard, "dashboard")
        for dashboard in root.findall("./dashboards/dashboard")
    })
    locator = f"artifact:{artifact_key}/workbook:dependency-closure"
    official_xsd_available = _official_twb_xsd_available(root)
    return _identity(
        SemanticRequirementIR(
            object_type="lineage",
            name=f"Tableau workbook {artifact_key}",
            support_outcome="manual",
            reason=(
                "Embedded workbook XML inventories local objects but does not prove complete "
                "Tableau Metadata API lineage, published dependencies, permissions, schedules, "
                "or source-query results. Official TWB XSD validation, where available, is only "
                "syntactic; this pass did not run XSD or Tableau semantic validation."
            ),
            dependencies=[*datasource_names, *worksheet_names, *dashboard_names],
            config={
                "source_contract": "tableau_twb_xml",
                "workbook_version": root.get("version"),
                "official_twb_xsd_baseline_available": official_xsd_available,
                "xsd_validation_performed": False,
                "semantic_validation_performed": False,
                "datasources": datasource_names,
                "worksheets": worksheet_names,
                "dashboards": dashboard_names,
                "metadata_api_lineage_complete": False,
                "permissions_inventoried": False,
                "schedules_inventoried": False,
                "source_query_validation_complete": False,
            },
        ),
        "semantic_requirement",
        locator,
    )


@dataclass(frozen=True)
class _LoadedTableauArtifact:
    root: ET.Element
    xml_member: str | None
    members: tuple[str, ...]


_MAX_TABLEAU_XML_BYTES = 64 * 1024 * 1024
_MAX_TABLEAU_PACKAGE_BYTES = 150 * 1024 * 1024


def _parse_tableau_xml(content: bytes, artifact_name: str) -> ET.Element:
    if len(content) > _MAX_TABLEAU_XML_BYTES:
        raise ValueError(
            f"Tableau XML exceeds the {_MAX_TABLEAU_XML_BYTES} byte parser limit: {artifact_name}"
        )
    if re.search(br"<!\s*(?:DOCTYPE|ENTITY)\b", content, flags=re.IGNORECASE):
        raise ValueError(f"Tableau XML declarations and entities are not accepted: {artifact_name}")
    try:
        return ET.fromstring(content)
    except ET.ParseError as error:
        raise ValueError(f"Invalid Tableau XML in {artifact_name}: {error}") from error


def _validate_tableau_root(root: ET.Element, expected_root: str, artifact_name: str) -> None:
    actual_root = _local_tag(root)
    if actual_root != expected_root:
        raise ValueError(
            f"Tableau artifact type mismatch for {artifact_name}: expected <{expected_root}>, "
            f"found <{actual_root}>"
        )


def _load_tableau_artifact(path: Path) -> _LoadedTableauArtifact:
    suffix = path.suffix.lower()
    if path.stat().st_size > _MAX_TABLEAU_PACKAGE_BYTES:
        raise ValueError(
            f"Tableau artifact exceeds the {_MAX_TABLEAU_PACKAGE_BYTES} byte parser limit: "
            f"{path.name}"
        )
    if zipfile.is_zipfile(path):
        expected_member_suffix = _PACKAGE_XML_MEMBER.get(suffix)
        if expected_member_suffix is None:
            raise ValueError(
                f"Packaged Tableau content must use .twbx or .tdsx: {path.name}"
            )
        with zipfile.ZipFile(path) as archive:
            entries = validate_zip_archive(archive, path.name)
            members = tuple(sorted(entry.filename for entry in entries))
            xml_members = [
                name for name in members if name.lower().endswith(expected_member_suffix)
            ]
            member = next((name for name in xml_members if "/" not in name), None)
            member = member or (xml_members[0] if xml_members else None)
            if not member:
                raise ValueError(
                    f"No {expected_member_suffix} inside packaged Tableau artifact {path.name}"
                )
            info = archive.getinfo(member)
            if info.file_size > _MAX_TABLEAU_XML_BYTES:
                raise ValueError(
                    f"Tableau XML exceeds the {_MAX_TABLEAU_XML_BYTES} byte parser limit: "
                    f"{path.name}:{member}"
                )
            content = read_zip_member_bounded(
                archive,
                info,
                archive_name=f"{path.name}:{member}",
                max_bytes=_MAX_TABLEAU_XML_BYTES,
            )
            root = _parse_tableau_xml(content, f"{path.name}:{member}")
            _validate_tableau_root(
                root,
                _DIRECT_XML_ROOT[expected_member_suffix],
                f"{path.name}:{member}",
            )
            return _LoadedTableauArtifact(root=root, xml_member=member, members=members)
    if suffix in _PACKAGE_XML_MEMBER:
        raise ValueError(f"Packaged Tableau artifact is not a valid ZIP archive: {path.name}")
    expected_root = _DIRECT_XML_ROOT.get(suffix)
    if expected_root is None:
        raise ValueError(f"Unsupported Tableau artifact extension: {path.name}")
    root = _parse_tableau_xml(
        read_file_bounded(path, max_bytes=_MAX_TABLEAU_XML_BYTES, label="Tableau XML"),
        path.name,
    )
    _validate_tableau_root(root, expected_root, path.name)
    return _LoadedTableauArtifact(
        root=root,
        xml_member=None,
        members=(),
    )


def _load_root(path: Path) -> ET.Element:
    """Parse the datasource/workbook XML from a .tds/.twb file or a .twbx/.tdsx zip.

    Packaged files (`.twbx`/`.tdsx`) are zips containing the `.twb`/`.tds` plus extracts
    and resources. The primary XML member is parsed; any additional members are surfaced in
    acquisition diagnostics rather than silently presented as parsed lineage.
    """
    return _load_tableau_artifact(path).root


def _artifact_fingerprint(inp: FileInput, path: Path) -> dict[str, str]:
    metadata = inp.artifact_metadata.get(path) or inp.artifact_metadata.get(path.resolve()) or {}
    actual_sha256 = sha256_file_bounded(
        path,
        max_bytes=_MAX_TABLEAU_PACKAGE_BYTES,
        label="Tableau artifact",
    )
    supplied_sha256 = metadata.get("sha256")
    if supplied_sha256 and str(supplied_sha256).lower() != actual_sha256.lower():
        raise ValueError(
            f"Tableau artifact SHA-256 mismatch for {path.name}; supplied metadata does not "
            "match the uploaded bytes"
        )
    return {
        "name": str(metadata.get("name") or path.name),
        "sha256": actual_sha256,
    }


def _stamp_source_evidence(value, kind: str, fingerprint: dict[str, str]) -> None:
    locator = value.source_locator or f"synthetic:{kind}:{content_sha256(value)[:16]}"
    _identity(value, kind, locator)
    value.evidence = [SourceEvidence(
        artifact_name=fingerprint["name"],
        artifact_sha256=fingerprint["sha256"],
        locator=locator,
        content_sha256=content_sha256(value),
        role="direct",
    )]


def _stamp_artifact_graph(
    *,
    views: list[ViewIR],
    topics: list[TopicIR],
    requirements: list[SemanticRequirementIR],
    dashboards: list,
    fingerprint: dict[str, str],
) -> None:
    for view in views:
        _stamp_source_evidence(view, "view", fingerprint)
        for field in view.fields:
            _stamp_source_evidence(field, "field", fingerprint)
    for topic in topics:
        _stamp_source_evidence(topic, "topic", fingerprint)
        for join in topic.joins:
            _stamp_source_evidence(join, "join", fingerprint)
    for requirement in requirements:
        _stamp_source_evidence(requirement, "semantic_requirement", fingerprint)
    for dashboard in dashboards:
        _stamp_source_evidence(dashboard, "dashboard", fingerprint)
        for filter_item in dashboard.filters:
            _stamp_source_evidence(filter_item, "filter", fingerprint)
        for tile in dashboard.tiles:
            _stamp_source_evidence(tile, "tile", fingerprint)
            if tile.query:
                _stamp_source_evidence(tile.query, "query", fingerprint)
                for filter_item in tile.query.filters:
                    _stamp_source_evidence(filter_item, "filter", fingerprint)
                for dynamic_field in tile.query.dynamic_fields:
                    _stamp_source_evidence(dynamic_field, "dynamic_field", fingerprint)


def _tableau_dependencies(
    root: ET.Element,
    *,
    artifact_key: str,
    source_file: str,
    members: tuple[str, ...],
    xml_member: str | None,
) -> tuple[list[AcquisitionDependencyIR], list[str]]:
    dependencies: list[AcquisitionDependencyIR] = []
    diagnostics = [
        (
            "This TWB version has an official Tableau XSD baseline, but this extraction did not "
            "run XSD or Tableau REST semantic validation."
            if _official_twb_xsd_available(root)
            else "This Tableau XML version has no matching official TWB XSD validation in this "
            "extraction pass; its source shape remains version-sensitive."
        ),
        "Fixture coverage does not replace Tableau Metadata API lineage or live-source validation.",
        "Manual artifacts do not establish permissions, schedules, or source-query results.",
        "File-based objects use artifact-scoped synthetic source IDs because Metadata API IDs are "
        "not present in TWB/TDS evidence.",
    ]
    datasource_elements = _embedded_datasources(root)
    datasource_ids = {
        identifier
        for datasource in datasource_elements
        for identifier in (datasource.get("name"), datasource.get("caption"))
        if identifier
    }
    worksheets = {
        worksheet.get("name"): worksheet
        for worksheet in root.findall("./worksheets/worksheet")
        if worksheet.get("name")
    }
    dashboards = {
        dashboard.get("name"): dashboard
        for dashboard in root.findall("./dashboards/dashboard")
        if dashboard.get("name")
    }

    dependencies.append(AcquisitionDependencyIR(
        kind="model",
        reference=artifact_key,
        source_file=source_file,
        status="resolved",
        message="Primary Tableau XML artifact parsed deterministically.",
    ))
    for datasource in datasource_elements:
        name = datasource.get("name") or datasource.get("caption") or _xml_key(
            datasource, "datasource"
        )
        dependencies.append(AcquisitionDependencyIR(
            kind="source",
            reference=name,
            source_file=source_file,
            status="resolved" if datasource.find("connection") is not None else "missing",
            message=(
                "Embedded datasource definition inventoried."
                if datasource.find("connection") is not None
                else "Datasource has no embedded connection; published/external lineage is missing."
            ),
        ))
        for relation in datasource.iter("relation"):
            if relation.get("type") == "text":
                dependencies.append(AcquisitionDependencyIR(
                    kind="lineage",
                    reference=f"{name}/custom-sql:{relation.get('name') or 'unnamed'}",
                    source_file=source_file,
                    status="review",
                    message=(
                        "Custom SQL was preserved, but upstream lineage and execution support are "
                        "not established."
                    ),
                ))

    for worksheet_name, worksheet in worksheets.items():
        affected = [
            dashboard_name
            for dashboard_name, dashboard in dashboards.items()
            if any(zone.get("name") == worksheet_name for zone in dashboard.iter("zone"))
        ]
        dependencies.append(AcquisitionDependencyIR(
            kind="page",
            reference=worksheet_name,
            source_file=source_file,
            status="resolved",
            affected_dashboard_ids=affected,
            message="Worksheet definition inventoried from the workbook.",
        ))
        for reference in worksheet.findall(".//datasources/datasource"):
            datasource_name = reference.get("name") or reference.get("caption")
            if not datasource_name:
                continue
            resolved = datasource_name in datasource_ids
            dependencies.append(AcquisitionDependencyIR(
                kind="source",
                reference=f"{worksheet_name}->{datasource_name}",
                source_file=source_file,
                status="resolved" if resolved else "missing",
                affected_dashboard_ids=affected,
                message=(
                    "Worksheet datasource reference resolved to an embedded definition."
                    if resolved
                    else "Worksheet datasource reference has no embedded definition."
                ),
            ))
        for filter_element in worksheet.findall(".//filter"):
            dependencies.append(AcquisitionDependencyIR(
                kind="filter",
                reference=f"{worksheet_name}:{filter_element.get('column') or 'unnamed'}",
                source_file=source_file,
                status="review",
                affected_dashboard_ids=affected,
                message=(
                    "Worksheet filter definition inventoried; Tableau order-of-operations behavior "
                    "requires target review."
                ),
            ))

    for dashboard_name, dashboard in dashboards.items():
        dependencies.append(AcquisitionDependencyIR(
            kind="dashboard",
            reference=dashboard_name,
            source_file=source_file,
            status="resolved",
            affected_dashboard_ids=[dashboard_name],
            message="Dashboard and source zone tree inventoried.",
        ))
        dependencies.append(AcquisitionDependencyIR(
            kind="lineage",
            reference=f"{dashboard_name}/layout",
            source_file=source_file,
            status="review",
            required=False,
            affected_dashboard_ids=[dashboard_name],
            message=(
                "Source geometry is preserved, but tiled/floating/device behavior and pixel parity "
                "are not established."
            ),
        ))
        for zone in dashboard.iter("zone"):
            zone_name = zone.get("name")
            zone_type = (zone.get("type-v2") or "").lower()
            if not zone_name or zone_type:
                continue
            resolved = zone_name in worksheets
            dependencies.append(AcquisitionDependencyIR(
                kind="page",
                reference=f"{dashboard_name}->{zone_name}",
                source_file=source_file,
                status="resolved" if resolved else "missing",
                affected_dashboard_ids=[dashboard_name],
                message=(
                    "Dashboard worksheet zone resolved to an embedded worksheet."
                    if resolved
                    else "Dashboard worksheet zone has no embedded worksheet definition."
                ),
            ))

    for index, relationship in enumerate(_logical_relationship_elements(root)):
        relationship_name = (
            relationship.get("name")
            or relationship.get("id")
            or f"relationship-{index + 1}"
        )
        dependencies.append(AcquisitionDependencyIR(
            kind="lineage",
            reference=f"{artifact_key}/logical-relationship:{relationship_name}",
            source_file=source_file,
            status="review",
            message=(
                "Logical relationship graph was inventoried, but contextual join behavior and "
                "cardinality were not translated."
            ),
        ))

    for action in root.iter("action"):
        action_name = action.get("caption") or action.get("name") or _xml_key(action, "action")
        dependencies.append(AcquisitionDependencyIR(
            kind="operation",
            reference=action_name,
            source_file=source_file,
            status="review",
            message="Dashboard/worksheet action inventoried and left unsupported for explicit review.",
        ))

    dependencies.extend([
        AcquisitionDependencyIR(
            kind="permission",
            reference=f"{artifact_key}/permissions",
            source_file=source_file,
            status="review",
            required=False,
            message="Manual TWB/TDS evidence does not establish workbook or datasource permissions.",
        ),
        AcquisitionDependencyIR(
            kind="schedule",
            reference=f"{artifact_key}/schedules",
            source_file=source_file,
            status="review",
            required=False,
            message="Manual TWB/TDS evidence does not establish refresh or subscription schedules.",
        ),
    ])

    if members:
        extra_xml = [
            member for member in members
            if member.lower().endswith((".twb", ".tds")) and member != xml_member
        ]
        for member in extra_xml:
            dependencies.append(AcquisitionDependencyIR(
                kind="include",
                reference=f"{source_file}:{member}",
                source_file=source_file,
                status="missing",
                matched_files=[member],
                message=(
                    "Additional packaged XML member was not parsed; package lineage is incomplete."
                ),
            ))
        data_members = [
            member for member in members
            if Path(member).suffix.lower() in _PACKAGED_DATA_SUFFIXES
        ]
        for member in data_members:
            dependencies.append(AcquisitionDependencyIR(
                kind="source",
                reference=f"{source_file}:{member}",
                source_file=source_file,
                status="review",
                required=False,
                matched_files=[member],
                message=(
                    "Packaged local data resource detected; row data, schema equivalence, and "
                    "source-query results were not read."
                ),
            ))
        layout_members = [
            member for member in members
            if Path(member).suffix.lower() in _PACKAGED_LAYOUT_SUFFIXES
        ]
        for member in layout_members:
            dependencies.append(AcquisitionDependencyIR(
                kind="visual",
                reference=f"{source_file}:{member}",
                source_file=source_file,
                status="review",
                required=False,
                matched_files=[member],
                message=(
                    "Packaged image/layout resource inventoried; placement and pixel parity are "
                    "not established."
                ),
            ))
        if extra_xml:
            diagnostics.append(
                f"{source_file} contains {len(extra_xml)} additional TWB/TDS member(s) not parsed."
            )
    return dependencies, diagnostics


def _has_blocking_lineage_gap(dependency: AcquisitionDependencyIR) -> bool:
    return (
        dependency.required
        and dependency.kind in _LINEAGE_BLOCKING_KINDS
        and dependency.status != "resolved"
    )


def _deduplicate_dependencies(
    dependencies: list[AcquisitionDependencyIR],
) -> list[AcquisitionDependencyIR]:
    unique: dict[tuple[str, str, str | None, str], AcquisitionDependencyIR] = {}
    for dependency in dependencies:
        key = (
            dependency.kind,
            dependency.reference,
            dependency.source_file,
            dependency.status,
        )
        unique.setdefault(key, dependency)
    return list(unique.values())


class TableauExtractor:
    source = "tableau"

    def detect(self, inp: ExtractorInput) -> bool:
        return isinstance(inp, FileInput) and any(
            str(p).endswith((".tds", ".twb", ".twbx", ".tdsx")) for p in inp.paths
        )

    def extract(self, inp: ExtractorInput, ctx: ExtractCtx | None = None) -> MigrationBundle:
        ctx = ctx or ExtractCtx()
        if not isinstance(inp, FileInput):
            raise TypeError("TableauExtractor supports FileInput (.tds/.twb).")
        model = ModelIR()
        dashboards = []
        artifacts: list[str] = []
        source_files: list[str] = []
        required_files: list[str] = []
        unrelated_files: list[str] = []
        dependencies: list[AcquisitionDependencyIR] = []
        diagnostics: list[str] = []
        for path in inp.paths:
            path = Path(path)
            artifacts.append(str(path))
            loaded = _load_tableau_artifact(path)
            root = loaded.root
            fingerprint = _artifact_fingerprint(inp, path)
            artifact_key = (
                f"{fingerprint['name']}:{loaded.xml_member}"
                if loaded.xml_member
                else fingerprint["name"]
            )
            source_files.append(fingerprint["name"])
            source_files.extend(
                f"{fingerprint['name']}:{member}" for member in loaded.members
            )
            required_files.append(fingerprint["name"])
            parsed_member = loaded.xml_member
            if loaded.members:
                unrelated_files.extend(
                    f"{fingerprint['name']}:{member}"
                    for member in loaded.members
                    if Path(member).suffix.lower()
                    not in {
                        ".twb", ".tds", *_PACKAGED_DATA_SUFFIXES,
                        *_PACKAGED_LAYOUT_SUFFIXES,
                    }
                )

            view_start = len(model.views)
            topic_start = len(model.topics)
            requirement_start = len(model.requirements)
            dashboard_start = len(dashboards)
            parameter_names, parameter_requirements = _parameter_requirements(root, artifact_key)
            model.requirements.extend(parameter_requirements)
            _, set_requirements = _set_requirements(root, artifact_key)
            model.requirements.extend(set_requirements)
            model.requirements.extend(
                _logical_relationship_requirements(root, artifact_key)
            )
            model.requirements.extend(
                _connection_requirements(root, artifact_key, loaded.members)
            )
            workbook_requirement = _workbook_lineage_requirement(root, artifact_key)
            if workbook_requirement:
                model.requirements.append(workbook_requirement)
            datasources = [root] if root.tag == "datasource" else [
                datasource
                for datasource in root.iter("datasource")
                # Worksheet references repeat a <datasource name=.../> pointer without a
                # connection or field definitions. Treating that pointer as a full source
                # fabricated an empty third view in workbook migrations.
                if datasource.find("connection") is not None or datasource.findall("column")
            ]
            for ds in datasources:
                if ds.get("name") == "Parameters":  # Tableau parameters pseudo-datasource
                    continue
                views, topic = _datasource(
                    ds,
                    ctx.default_schema,
                    artifact_key=artifact_key,
                    requirements=model.requirements,
                    parameter_names=parameter_names,
                )
                model.views.extend(views)
                if topic:
                    model.topics.append(topic)
            if root.tag != "datasource":
                from omni_migrator.extractors.tableau.dashboard import (
                    list_tableau_dashboards,
                    tableau_dashboard_requirements,
                    translate_tableau_dashboard,
                )

                for name in list_tableau_dashboards(root):
                    dashboards.append(translate_tableau_dashboard(
                        root,
                        name,
                        source_url=fingerprint["name"],
                        artifact_key=artifact_key,
                    ))
                    model.requirements.extend(
                        tableau_dashboard_requirements(root, name, artifact_key=artifact_key)
                    )

            artifact_dependencies, artifact_diagnostics = _tableau_dependencies(
                root,
                artifact_key=artifact_key,
                source_file=fingerprint["name"],
                members=loaded.members,
                xml_member=parsed_member,
            )
            dependencies.extend(artifact_dependencies)
            diagnostics.extend(artifact_diagnostics)
            _stamp_artifact_graph(
                views=model.views[view_start:],
                topics=model.topics[topic_start:],
                requirements=model.requirements[requirement_start:],
                dashboards=dashboards[dashboard_start:],
                fingerprint=fingerprint,
            )
        dependencies = _deduplicate_dependencies(dependencies)
        has_blocking_lineage_gap = any(
            _has_blocking_lineage_gap(dependency) for dependency in dependencies
        )
        closure_status = "blocked" if has_blocking_lineage_gap else "partial"
        return MigrationBundle(
            source="tableau",
            provenance=Provenance(source_artifact=", ".join(artifacts)),
            acquisition=AcquisitionEvidenceIR(
                contract_version="tableau.evidence.v1",
                mode="manual",
                dashboard_ids=sorted({dashboard.name for dashboard in dashboards}),
                source_files=sorted(set(source_files)),
                required_files=sorted(set(required_files)),
                unrelated_files=sorted(set(unrelated_files)),
                dependencies=dependencies,
                saved_look_coverage="not_applicable",
                dependency_closure_status=closure_status,
                source_query_validation_status="not_evaluated",
                diagnostics=list(dict.fromkeys(diagnostics)),
            ),
            model=model,
            dashboards=dashboards,
        )
