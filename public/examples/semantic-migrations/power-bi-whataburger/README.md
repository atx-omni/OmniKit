# Simulated Whataburger Power BI Migration Bundle

This fixture is a synthetic Power BI project reconstructed from the OmniKit Whataburger demonstration. It is not a production Power BI export, Whataburger-owned data, or evidence from a customer tenant.

The bundle mirrors Microsoft-documented manual migration inputs:

- `whataburger-workspace.json` provides optional workspace context similar to scanner metadata.
- `whataburger-model.bim` contains a tabular semantic model with tables, columns, DAX measures, and relationships.
- `whataburger-report.json` contains report, page, visual, filter, and field-reference evidence comparable to an aggregated PBIR export.

The independent `expected-omni` folder is used only as a structural review baseline. A 90% or better parser score does not prove DAX parity, Power Query behavior, RLS equivalence, visual fidelity, or successful deployment.
