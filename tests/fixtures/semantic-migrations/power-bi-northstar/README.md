# Northstar Food Service Power BI benchmark

This fixture is a fictional Power BI project created for deterministic parser and migration workflow testing. It is not a customer export or evidence from a production Power BI tenant.

The bundle mirrors Microsoft-documented manual migration inputs:

- `northstar-workspace.json` provides optional workspace context similar to scanner metadata.
- `northstar-model.bim` contains a tabular semantic model with tables, columns, DAX measures, and relationships.
- `northstar-report.json` contains report, page, visual, filter, and field-reference evidence comparable to an aggregated PBIR export.

The independent `expected-omni` folder is used only as a structural review baseline. A 90% or better parser score does not prove DAX parity, Power Query behavior, RLS equivalence, visual fidelity, or successful deployment.
