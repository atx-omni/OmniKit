"""Tableau extractor: .tds / .twb (datasource XML) -> canonical IR.

Dashboard translation lives in `dashboard.py` (built 2026-07-06, still unverified against a live
Tableau instance). Parsing here is via the stdlib XML parser; mapping follows the snowparser
design (plan §6.1, Appendix A.7):

- `<relation type='table'>` -> ViewIR (schema/table from the table attr).
- `<relation type='join'>` -> JoinIR/TopicIR, from the relation's `<clause type='join'>`
  (2026-07-10 — previously silently produced an empty-joins topic for every multi-table
  datasource, no matter what the clause said). Only the unambiguous 2-relation case is
  translated; chained/multi-way joins are flagged, not guessed. **No live Tableau instance
  exists in this repo to verify this join-clause shape against** — treat with real skepticism.
- `<relation type='text'>` (Custom SQL) -> a derived-table ViewIR (raw SQL verbatim), the same
  treatment as a Metabase native-SQL "Model" (2026-07-10 — previously silently synthesized an
  empty view with zero fields for a 100%-custom-SQL datasource, with no note at all).
- `<column role='dimension'|'measure'>` -> FieldIR; sql resolved to the bare `<remote>`
  column name (Omni has no `${TABLE}` token) via the connection's `<metadata-record>` map.
- Calculated columns (`<calculation class='tableau' formula=...>`): resolve `[Ref]`s to
  physical columns; classify dimension vs measure (clean aggregate wrapper) vs
  untranslatable (LOD / unresolved refs / nested aggregates).
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

from omni_migrator.core.contracts import ExtractCtx, ExtractorInput, FileInput
from omni_migrator.deterministic.sql_cleanup import apply_sql_fixups
from omni_migrator.ir.schema import (
    ConnectionRef,
    FieldIR,
    JoinIR,
    MigrationBundle,
    ModelIR,
    Provenance,
    TopicIR,
    UntranslatableNote,
    ViewIR,
)

_LOD = re.compile(r"\{\s*(FIXED|INCLUDE|EXCLUDE)\b", re.IGNORECASE)
_REF = re.compile(r"\[([^\]]+)\]")
_AGG_WRAP = re.compile(r"^\s*(SUM|AVG|COUNTD|COUNT|MIN|MAX|MEDIAN)\s*\((.*)\)\s*$", re.IGNORECASE | re.DOTALL)
_AGG_ANY = re.compile(r"\b(SUM|AVG|COUNTD?|MIN|MAX|MEDIAN|ATTR|TOTAL|WINDOW_\w+|RUNNING_\w+|RANK\w*)\s*\(", re.IGNORECASE)
_AGG_MAP = {"sum": "sum", "avg": "average", "count": "count", "countd": "count_distinct",
            "min": "min", "max": "max", "median": "median"}
_DTYPE = {"integer": "number", "real": "number", "number": "number",
          "string": "string", "boolean": "boolean", "date": "date", "datetime": "timestamp"}

# dialect inferred from the Tableau connection `class`
_DIALECT = {"snowflake": "snowflake", "bigquery": "bigquery", "redshift": "redshift",
            "postgres": "postgres", "sqlserver": "other", "mysql": "mysql", "databricks": "databricks"}

# a join relation's `join='inner'|'left'|'right'|'full'` attribute -> Omni's JoinType enum
_JOIN_TYPE = {"inner": "always_inner", "left": "always_left", "right": "always_right", "full": "always_full"}


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
    """Resolves `[Ref]` tokens to bare physical column names.

    Omni has no `${TABLE}` token (verified against `docs.omni.co/modeling` and the Omni
    compiler source) — a view's `sql:` is scoped to its own table, so physical columns are
    referenced bare; `${...}` is reserved for *field* references, not raw columns.
    """

    def __init__(self, meta: dict[str, str]):
        self.meta = meta
        self.ref_sql: dict[str, str] = {}  # key (caption or name, no brackets) -> bare column

    def register_physical(self, key_caption: str | None, key_name: str | None, remote: str | None):
        for k in (key_caption, key_name):
            if k and remote:
                self.ref_sql[k] = remote

    def remote_for(self, name_no_brackets: str, caption: str | None) -> str | None:
        return self.meta.get(name_no_brackets) or (self.meta.get(caption) if caption else None)

    def translate(self, formula: str) -> tuple[str | None, list[str]]:
        """Return (translated_sql, unresolved_refs)."""
        unresolved: list[str] = []

        def repl(m: re.Match) -> str:
            key = m.group(1)
            if key in self.ref_sql:
                return self.ref_sql[key]
            # physical column by metadata as a fallback
            remote = self.meta.get(key)
            if remote:
                return remote
            unresolved.append(key)
            return m.group(0)

        out = apply_sql_fixups(_REF.sub(repl, formula))
        return (out, unresolved)


def _calc_field(col: ET.Element, formula: str, role: str, resolver: _Resolver):
    """Classify a calculated field -> (FieldIR | None, UntranslatableNote | None)."""
    caption = col.get("caption") or _strip_brackets(col.get("name") or "calc")
    name = _snake(caption)
    obj = f"calculated field {caption}"

    if _LOD.search(formula):
        return None, UntranslatableNote(object=obj, severity="warning", hint=formula,
                                        reason="Level-of-Detail expression has no Omni equivalent.")

    wrap = _AGG_WRAP.match(formula)
    if wrap:
        func = wrap.group(1).lower()
        inner = wrap.group(2)
        if _AGG_ANY.search(inner):  # nested aggregate -> needs AI
            return None, UntranslatableNote(object=obj, severity="warning", hint=formula,
                                            reason="Nested aggregate; needs AI translation.")
        sql, unresolved = resolver.translate(inner)
        if unresolved:
            return None, UntranslatableNote(object=obj, severity="warning", hint=formula,
                                            reason=f"Unresolved reference(s): {', '.join(sorted(set(unresolved)))}.")
        return FieldIR(name=name, source_name=caption, kind="measure", data_type="number",
                       sql=sql, aggregate=_AGG_MAP.get(func, "sum")), None

    if _AGG_ANY.search(formula):  # aggregate present but not a clean wrapper
        return None, UntranslatableNote(object=obj, severity="warning", hint=formula,
                                        reason="Aggregate not a clean wrapper; needs AI translation.")

    # non-aggregate -> dimension
    sql, unresolved = resolver.translate(formula)
    if unresolved:
        return None, UntranslatableNote(object=obj, severity="warning", hint=formula,
                                        reason=f"Unresolved reference(s): {', '.join(sorted(set(unresolved)))}.")
    return FieldIR(name=name, source_name=caption, kind="dimension",
                   data_type=_datatype(col), sql=sql), None


def _relation_sql_text(rel: ET.Element) -> str:
    """A custom-SQL (`type='text'`) relation's raw SQL. Tableau XML-escapes literal `<`/`>` in
    some exported versions as `<<`/`>>` inside this text node — undo that if present, otherwise
    the plain text content."""
    text = rel.text or ""
    return text.replace("<<", "<").replace(">>", ">").strip()


def _join_clause_edges(rel: ET.Element) -> list[tuple[str, str, str, str]]:
    """A join relation's `<clause type='join'>` -> `[(table_a, col_a, table_b, col_b), ...]`
    for every `=` equality found (top-level or AND-nested, for a composite join key) — e.g.
    `[Orders].[Customer_Id] = [Customers].[Id]`. Best-effort against Tableau's documented/
    community-reverse-engineered `.twb`/`.tds` join-clause shape — **no live Tableau instance
    exists in this repo to verify it against** (see the module docstring's caveat); treat with
    the same skepticism as the dashboard translator until spot-checked live."""
    edges: list[tuple[str, str, str, str]] = []
    clause = rel.find("clause")
    if clause is None or clause.get("type") != "join":
        return edges
    for eq in clause.iter("expression"):
        if eq.get("op") != "=":
            continue
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


def _join_relation_edges(rel: ET.Element) -> list[tuple[str, str, str, str, str]]:
    """A `<relation type='join'>` -> `[(from_ref, from_col, to_ref, to_col, join_attr), ...]` —
    only for the unambiguous case where both direct children are plain table/custom-SQL
    relations, never another nested join. Chained/multi-way joins are left flagged for a human
    rather than guessed at (same "translate the unambiguous, flag the rest" discipline as
    everywhere else in this extractor)."""
    children = [c for c in rel if c.tag == "relation"]
    if len(children) != 2 or any(c.get("type") not in ("table", "text") for c in children):
        return []
    join_attr = rel.get("join") or "inner"
    return [(*edge, join_attr) for edge in _join_clause_edges(rel)]


def _datasource(ds: ET.Element, default_schema: str | None):
    conn = ds.find("connection")
    meta = _metadata_map(conn) if conn is not None else {}
    field_parents = _metadata_parent_map(conn) if conn is not None else {}
    cls = (conn.get("class") if conn is not None else None) or ""
    dialect = _DIALECT.get(cls.lower(), "other")

    # tables (and custom-SQL relations) -> views
    views: dict[str, ViewIR] = {}
    table_views: list[str] = []
    view_by_relation_name: dict[str, str] = {}
    if conn is not None:
        for rel in conn.iter("relation"):
            if rel.get("type") == "table":
                schema, table = _parse_table_attr(rel.get("table"))
                vname = _snake(rel.get("name") or table or "view")
                views[vname] = ViewIR(
                    name=vname, schema_name=schema or default_schema, source_table=table,
                    connection=ConnectionRef(source_connection_name=cls, dialect=dialect),
                )
            elif rel.get("type") == "text":
                # Custom-SQL relation: a derived-table view (raw SQL verbatim), the same
                # treatment as a Metabase native-SQL "Model" — not silently dropped/emptied.
                vname = _snake(rel.get("name") or "custom_sql")
                views[vname] = ViewIR(
                    name=vname, sql=_relation_sql_text(rel),
                    connection=ConnectionRef(source_connection_name=cls, dialect=dialect),
                )
            else:
                continue
            view_by_relation_name[rel.get("name") or ""] = vname
            table_views.append(vname)
    if not views:  # datasource with no explicit relation: synthesize one view
        vname = _snake(ds.get("formatted-name") or ds.get("name") or "extract")
        views[vname] = ViewIR(name=vname, connection=ConnectionRef(dialect=dialect))
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
            calc_cols.append((col, calc.get("formula")))
        else:
            caption = col.get("caption") or _strip_brackets(col.get("name") or "")
            name_nb = _strip_brackets(col.get("name") or "")
            remote = resolver.remote_for(name_nb, caption)
            resolver.register_physical(caption, name_nb, remote)
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
        if role == "measure":
            destination.fields.append(
                FieldIR(name=field_name, source_name=caption, kind="measure",
                        data_type="number", sql=sql, aggregate="sum")
            )
            # Tableau's `role="measure"` says nothing about *how* to aggregate (unlike a
            # LookML measure's `type:`) — `sum` is our default, not a derived fact. Flag it
            # so the AI knows to verify rather than assuming it's mechanically certain.
            destination.untranslatable.append(UntranslatableNote(
                object=f"measure {caption}", severity="info",
                reason="Tableau gives no explicit aggregation for a plain measure-role "
                       "column; defaulted to 'sum' — confirm this matches intended usage.",
            ))
        else:
            destination.fields.append(
                FieldIR(name=field_name, source_name=caption, kind="dimension",
                        data_type=_datatype(col), sql=sql)
            )

    # calculated columns -> resolved
    for col, formula in calc_cols:
        field, note = _calc_field(col, formula, (col.get("role") or "dimension").lower(), resolver)
        if field:
            primary_view.fields.append(field)
        if note:
            primary_view.untranslatable.append(note)

    # joins between table-views -> a topic, from real <relation type='join'> clauses (previously
    # this always produced an empty topic with zero joins, silently, for any multi-table
    # datasource — the join clause was never actually read).
    topic = None
    if len(table_views) > 1 and conn is not None:
        topic = TopicIR(name=primary_view.name, base_view=primary_view.name)
        for rel in conn.iter("relation"):
            if rel.get("type") != "join":
                continue
            edges = _join_relation_edges(rel)
            if not edges:
                primary_view.untranslatable.append(UntranslatableNote(
                    object="join", severity="warning",
                    reason="Could not resolve a simple 2-relation join condition (a chained/"
                    "multi-way join, or an unrecognized <clause> shape) — needs manual/AI join "
                    "wiring, not guessed.",
                ))
                continue
            for from_ref, from_col, to_ref, to_col, join_attr in edges:
                from_view, to_view = view_by_relation_name.get(from_ref), view_by_relation_name.get(to_ref)
                if not from_view or not to_view:
                    primary_view.untranslatable.append(UntranslatableNote(
                        object="join", severity="warning",
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
                        view.fields.append(FieldIR(
                            name=field_name, source_name=col_name, kind="dimension",
                            sql=meta.get(col_name, col_name),
                        ))
                topic.joins.append(JoinIR(
                    join_from_view=from_view, join_to_view=to_view,
                    join_type=_JOIN_TYPE.get(join_attr, "always_left"),
                    relationship_type="many_to_one",
                    on_sql=f"${{{from_view}.{from_field}}} = ${{{to_view}.{to_field}}}",
                ))
                primary_view.untranslatable.append(UntranslatableNote(
                    object=f"join {from_view}.{from_field} -> {to_view}.{to_field}", severity="info",
                    reason="Join and its cardinality are read from the Tableau relation's join "
                    "clause, not asserted metadata — Tableau carries no explicit cardinality "
                    "(mirrors Looker/Metabase's own FK-side inference), so 'many_to_one' is a "
                    "default, not a derived fact. Verify before trusting a 1:1/1:many relationship. "
                    "This join-clause parsing path also has no live Tableau instance to verify "
                    "against yet — treat with extra skepticism.",
                ))
    return list(views.values()), topic


def _load_root(path: Path) -> ET.Element:
    """Parse the datasource/workbook XML from a .tds/.twb file or a .twbx/.tdsx zip.

    Packaged files (`.twbx`/`.tdsx`) are zips containing the `.twb`/`.tds` plus extracts
    and resources — we read only the XML member.
    """
    def parse_xml(content: bytes, artifact_name: str) -> ET.Element:
        if re.search(br"<!\s*(?:DOCTYPE|ENTITY)\b", content, flags=re.IGNORECASE):
            raise ValueError(f"Tableau XML declarations and entities are not accepted: {artifact_name}")
        return ET.fromstring(content)

    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as zf:
            member = next(
                (n for n in zf.namelist() if n.endswith((".twb", ".tds")) and "/" not in n),
                None,
            ) or next((n for n in zf.namelist() if n.endswith((".twb", ".tds"))), None)
            if not member:
                raise ValueError(f"No .twb/.tds inside {path.name}")
            return parse_xml(zf.read(member), f"{path.name}:{member}")
    return parse_xml(path.read_bytes(), path.name)


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
        for path in inp.paths:
            path = Path(path)
            artifacts.append(str(path))
            root = _load_root(path)
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
                views, topic = _datasource(ds, ctx.default_schema)
                model.views.extend(views)
                if topic:
                    model.topics.append(topic)
            if root.tag != "datasource":
                from omni_migrator.extractors.tableau.dashboard import (
                    list_tableau_dashboards,
                    translate_tableau_dashboard,
                )

                dashboards.extend(
                    translate_tableau_dashboard(root, name, source_url=path.name)
                    for name in list_tableau_dashboards(root)
                )
        return MigrationBundle(
            source="tableau",
            provenance=Provenance(source_artifact=", ".join(artifacts)),
            model=model,
            dashboards=dashboards,
        )
