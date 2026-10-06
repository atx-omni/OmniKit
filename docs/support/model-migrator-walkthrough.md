# Model Migrator: prepare a review branch

## One workflow

OmniKit packages authored semantic definitions. The user finishes and publishes them in Omni. This workflow does not translate SQL automatically, move warehouse data, copy dashboards, merge models, create pull requests, delete branches, refresh schemas, or run post-actions.

1. **Connections:** choose the source and destination instance, connection, and shared model. The destination is always an explicit choice.
2. **Topics:** select only the topics you need. OmniKit includes required views, referenced fields, and relationship entries—not all relationships or unrelated topics. Query views are included only when they are actual authored dependencies.
3. **Review differences:** inspect **New file**, **Additions**, **Already present**, and **Conflict**. Existing destination definitions are preserved. Optional catalog/schema substitutions are collapsed by default and every change appears in the differences. They do not prove warehouse compatibility.
4. **Prepare review branch:** approve the exact package and choose **Create review branch**. OmniKit rereads the source and destination, creates a branch, writes approved additions, and reads the branch back to verify those writes. Success is **Review branch prepared**, not migration complete.
5. **Finish in Omni:** open Omni, enter the destination model editor, and select the recorded branch name. Review SQL/table references, validate the model and content, test representative queries and access behavior, and publish or request review there. A verified direct branch URL is not yet available; the handoff provides the instance link, branch name, and identifiers instead of guessing one.

## What blocks preparation?

- Missing, unreadable, or ambiguous required authored definitions.
- A change that would overwrite an existing definition or change an existing relationship.
- Security/access-grant differences that cannot be preserved safely. Missing required grants need a separate reviewed model change; OmniKit does not guess or broaden access policies.
- Missing write authority, changed source/destination evidence, expired review, or an uncertain prior submission.

SQL dialect differences, unverified warehouse tables/columns, and query/business validation are **Finish in Omni** warnings. They do not require editing SQL or filling out physical mappings in OmniKit. Warnings retain affected-file details, collapsed by default. Hold affected topics to reduce a blocked package, or correct the definitions in Omni and compare again.

## Dashboard handoff

Dashboard Migrator opens the same branch-preparation experience with a server-bound source, destination, document scope, and reviewed dependency package. Required authored definitions and explicitly reviewed proposed-topic packages use the same branch-only executor. A missing source topic is not silently reconstructed as equivalent semantics.

Preparing a branch does **not** make a dashboard destination ready. After manually publishing reviewed model changes in Omni, return to the dashboard plan and explicitly recheck readiness. Multi-source-model repairs require a smaller, explicitly reviewed scope; they do not silently become a whole-model migration.

## Resume, cancellation, and partial outcomes

- Browser storage contains only plan/job references—not definitions, credentials, or approvals.
- Restored, expired, changed, or legacy unsubmitted plans require a fresh comparison and approval.
- Legacy history stays readable. Old approvals, publication controls, and generic model-job retries cannot execute the retired workflow.
- **Check saved run** rereads the persisted outcome. An uncertain response must never trigger an automatic repeat of branch creation or writes.
- **Stop remaining work** is not rollback. Completed files remain on the review branch; partial preparation is reported as such.
- **Export review and outcome report** contains topic/file actions and operation statuses without raw YAML, credentials, or opaque execution inputs.

## Acceptance boundary

Local unit/type/lint checks establish development confidence only. A separately authorized live pilot must still verify the branch contents, confirm the shared model is unchanged, exercise the Omni handoff, and test destination query and access behavior. Do not call the workflow production-ready solely because local checks pass.

## Superseded workflow

The former guided/advanced split, required physical table/column mapping, in-app SQL correction, automatic native validation, and OmniKit publication steps are retired. Earlier observations and test results are not acceptance evidence for this replacement.
