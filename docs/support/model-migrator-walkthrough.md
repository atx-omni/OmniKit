# Model Migrator: prepare a branch and review a Blobby repair

## One workflow

OmniKit packages authored semantic definitions, then helps you repair the resulting branch with Blobby and review the actual changes. You finish and publish in Omni. Branch preparation, Blobby execution, file inspection, model validation, and human acceptance are separate outcomes. This workflow does not move warehouse data, copy dashboards, merge models, create pull requests, delete branches, refresh schemas, or run post-actions.

1. **Connections:** choose the source and destination instance, connection, and shared model. The destination is always an explicit choice.
2. **Topics:** select only the topics you need. OmniKit includes required views, referenced fields, and relationship entries—not all relationships or unrelated topics. Query views are included only when they are actual authored dependencies.
3. **Review differences:** inspect **New file**, **Additions**, **Already present**, and **Conflict**. Existing destination definitions are preserved. Optional catalog/schema substitutions are collapsed by default. New preparation plans preserve the reviewed definitions and mappings; they do not apply the earlier automatic table-spelling or SQL identifier conversions. Destination adaptations belong to the subsequent scoped Blobby repair.
4. **Prepare review branch:** approve the exact package and choose **Create review branch**. OmniKit rereads the source and destination, creates a branch, writes approved additions, and reads the branch back to verify those writes. Success is **Review branch prepared**, not migration complete.
5. **Repair with Blobby:** choose **Prepare Blobby repair** for the existing standalone review branch. Confirm the exact branch and file scope, begin one repair session, and inspect the actual read-back changes. Validate the branch and explicitly accept the reviewed result. The default flow runs Blobby in Omni using copyable scoped instructions.
6. **Finish in Omni:** complete affected-content checks and representative query and access tests, then publish or request review manually. The handoff provides the instance link, branch name, and identifiers; it does not guess a direct branch link.

New review branches use `omnikit-topics-YYYY-MM-DD-HH-mm-ss-SSS-utc`, based on when the review plan is created. A numeric suffix distinguishes plans created at the same millisecond. Existing branch names remain unchanged.

## Stable review and existing-branch verification

Optional namespace discovery finishes before OmniKit captures the review baseline. Approval and verification use an explicit combined, unresolved YAML inventory with checksums. Two consecutive reads must agree; a changing inventory or checksum stops the check rather than polling or silently replacing the approved snapshot. This checks returned evidence for stability, not warehouse completeness or query correctness.

If preparation writes succeeded but verification needs review, choose **Verify existing branch**. This only reads the recorded branch and appends a separate observation; it does not replay writes, create another branch, change the original result, or renew the consumed approval.

The result separates **copied-file matches** from **source/destination changes**. Added, removed, and changed destination files are listed without guessing whether they came from a user, background schema activity, or another process. A readable branch can show matching copied files while the overall verification still requires review. Changed authority, unavailable reads, or unstable reads do not establish file mismatches. Genuine content differences remain explicit. No drift result supplies a verified receipt or unlocks automated correction writes; finish the review in Omni.

## Keep an existing destination view’s definitions

Some existing views contain valid destination-specific definitions that should remain intact even when the source differs. For server-eligible view conflicts, the file review offers **Keep destination definitions; add only missing items**. A blocked file or similarly named view alone does not enable this option. Query views, security conflicts, ambiguous shapes, and other unsupported cases remain blocked.

1. Expand the affected view and inspect its current destination definition and incoming comparison.
2. Check the per-view confirmation and choose **Keep destination definitions and recheck**. This preserves complete existing destination fields and view properties; it adds only supported complete missing source fields. It does not fill missing properties inside an existing destination field or overwrite its SQL, filters, formatting, or other attributes.
3. Review the fresh differences and **Retained versus added items**. The chosen result lists retained paths separately from missing items proposed as additions. **Source properties not copied** identifies source-only view properties and attributes inside retained fields that were intentionally excluded, including properties that may affect business behavior. Other topic, relationship, or security conflicts may still block preparation.
4. Approve the fresh branch-preparation package only after reviewing the resulting scope. Choosing a preservation policy performs a fresh read; it does not write model files or preserve a previous approval.

The choice is bound to the exact source/destination snapshots and destination file. Rechecking the same request retains it; changing the connection pair, topic selection, or location mappings clears it. Changed source or destination evidence requires renewed review. **Selected destination-preserving choices** lets you remove a choice and recheck, including after a failed or stale review.

Retaining destination definitions preserves destination behavior; it does not prove equivalence to the source. Validate dependent topics, source-only additions, representative queries, and access behavior before publication. An unchanged destination-preserving result may still differ from the source by design.

## One scoped Blobby repair

The repair context records the source and destination dialects, exact model and branch, and reviewed files from the original preparation. Scope and branch evidence remain bound to the saved repair. A later comparison, expired approval, or restored browser session cannot silently start another Blobby request or replace that baseline.

Blobby may propose destination-specific SQL and model repairs. Its response is not proof that files changed correctly, the shared model stayed unchanged, or warehouse queries are valid. OmniKit reads actual full before/after files, reports scope findings, and keeps native model validation separate. Human review is required before accepting the branch result.

The default execution path is **Run Blobby in Omni**. Automated API execution is enabled only by a server-controlled, exact-target rollout after its branch and sandbox controls are independently verified. Users cannot turn it on by changing a browser option or request body. A closed API gate leaves the native handoff usable.

### Native Blobby handoff

1. Choose **Prepare Blobby repair**. Confirm the branch name, branch ID, model ID, dialect pair, and reviewed file scope.
2. Check the approval box and choose **Begin Blobby handoff**. This records the baseline for one scoped session; it does not submit an API job or perform model edits.
3. Choose **Copy scoped repair instructions**, then **Open Omni — select branch**. In Omni’s model editor, select the exact recorded branch and give Blobby those instructions. The copied header includes its readable name, model ID, and branch ID, and asks Blobby to confirm the active branch before editing; neither the prompt nor the instance link selects a branch. Use Blobby’s Sandbox mode to review proposed edits before applying them to the branch. Keep changes within the reviewed files and keep the shared model unchanged. OmniKit does not set or enforce this native mode.
4. After Blobby finishes, return to OmniKit and choose **Check Blobby’s changes**. This reads the existing branch; it does not submit another repair. Native handoffs are checked when you request it rather than by automatic polling.
5. Expand every file under **Before Blobby → Actual branch now**. Created, changed, and deleted files remain explicit. Findings are grouped by file and separated into errors/blockers and warnings.
6. Choose **Validate branch model**. **Not run**, **Issues found**, and **Unavailable** do not establish successful validation. Acceptance requires a passed validation bound to the same branch contents, verified shared-model stability, no blocking findings, and review of every changed file.
7. Check the separate acceptance box and choose **Accept reviewed branch result**. The server rereads the branch before recording acceptance. This does not publish the model or establish query/business acceptance.

An inspected branch that needs no file changes can also be accepted after exact-branch validation passes and the other review gates hold. This records the validated unchanged state; it does not claim that Blobby authored a repair.

Copyable instructions carry the validation timestamp and branch-content hash. Validation refreshes the prompt from the current selected authored members without resetting the original review baseline or widening repair authority. Once inspection detects a changed branch, the old instructions cannot be copied; validate again to refresh them. Legacy saved handoffs also require refreshed context. Unobserved external edits still require a fresh check.

Validator filenames are resolved against the complete branch inventory; a unique basename can match a namespaced authored file, but ambiguous or unselected files stay context-only. Table errors may retain redacted text. Where a selected view has explicit safe literal `catalog`, `schema`, and `table_name` properties, the prompt includes those separately as authored expectations—not evidence of warehouse existence or access. Arbitrary error strings are never unredacted.

If no changes are confirmed or findings need input, continue the same scoped session in Omni and check again. **Prepare another repair pass** appears only when the server confirms the prior pass is inspected and reconciled sufficiently to permit it. That explicit action links a new review to its predecessor and requires new approval; it cannot erase unresolved evidence.

### Controlled API execution

For a server-enabled target, the same review offers **Run Blobby on this branch**. Approval starts one branch-bound request. Progress shows the current stage without an invented completion percentage. OmniKit inspects a running API job for at most one minute; **Check Blobby’s changes** performs another read when needed. Inspection, validation, and acceptance follow the same evidence boundaries as the native handoff.

A disconnected start response is an unknown submission outcome. **Check saved repair** reads persisted state; **Check Blobby’s changes** inspects remote state and the branch. Neither repeats the submission. Do not retry or start another session while the outcome is uncertain.

**Request Blobby stop** requests cancellation of the API job. Its current iteration may still finish; inspect until the remote job is terminal. A stop response alone does not establish that writes stopped or undo any branch edits.

### Compare again after a submitted run

Use **Start fresh comparison** to read current source/destination definitions for the same connection pair and topics. Location mappings can be revised and compared again. This creates a separate read-only comparison, not another approval. It shows current differences and links to the saved run without changing its outcome, branch, or consumed approval. A successful branch readback does not authorize another write. Changing the connection pair or topic selection starts an ordinary review with the existing submission safeguards.

The comparison cannot create a branch, even through a direct staging request. Restoring or rechecking it retains that boundary. When saved evidence instead indicates a verified prewrite failure or reconciled no-write outcome, **Review again after no-write recovery** retains the existing independently approved recovery path; the server rechecks all applicable claims and recovery evidence. No comparison automatically repairs or republishes an existing branch.

### Completion checklist

- Confirm the recorded instance, destination model, and branch before approval. Resuming a saved run does not create a new branch or change its historical name.
- Inspect every actual changed file and confirm shared-model verification reports unchanged. Investigate independent shared-model changes before publication.
- Read the model-validation result. A completed Blobby job or a file diff does not mean SQL or warehouse behavior passed. **Unavailable** requires a later successful check, not dismissal.
- In Omni, complete affected-content checks, test representative destination queries and access behavior, and obtain the required human review before publishing. Branch repair acceptance is not publication.
- Export the original preparation and repair summaries if an audit handoff is needed. The repair summary excludes raw prompts, YAML, SQL values, credentials, and free-form diagnostic messages. Leave unresolved findings explicit rather than marking the migration complete.

## What blocks preparation?

- Missing, unreadable, or ambiguous required authored definitions.
- A change that would overwrite an existing definition or change an existing relationship.
- Security/access-grant differences that cannot be preserved safely. Missing required grants need a separate reviewed model change; OmniKit does not guess or broaden access policies.
- Missing write authority, changed source/destination evidence, expired review, or an uncertain prior submission.

SQL dialect differences, unverified warehouse tables/columns, and query/business validation remain review needs. They do not require editing SQL or filling out physical mappings in OmniKit. After branch preparation, use the scoped Blobby repair and inspect its output. Hold affected topics to reduce a blocked preparation package, or correct the definitions in Omni and compare again.

### If Omni reports “Table not found”

File verification confirms that the approved definitions reached the branch; it does not validate their warehouse bindings. Compare the affected view’s catalog, schema, table name, and destination inventory. Give Blobby the scoped repair context and review any resulting changes before accepting them. Do not assume that a similarly named table is equivalent.

If validation still reports a missing table, compare the affected view's `catalog`, `schema`, and `table_name` with the destination inventory. Investigate table availability, connection permissions, and schema freshness before choosing a replacement. Do not recreate a table or assume that a similarly named table has equivalent columns and behavior. Correct confirmed bindings in the review branch and validate again.

## Dashboard handoff

Dashboard Migrator opens the same branch-preparation experience with a server-bound source, destination, document scope, and reviewed dependency package. Required authored definitions and explicitly reviewed proposed-topic packages use the same branch-only executor. A missing source topic is not silently reconstructed as equivalent semantics.

Preparing a branch does **not** make a dashboard destination ready. After manually publishing reviewed model changes in Omni, return to the dashboard plan and explicitly recheck readiness. Multi-source-model repairs require a smaller, explicitly reviewed scope; they do not silently become a whole-model migration.

## Resume, cancellation, and partial outcomes

- Browser storage contains only plan/job/repair references—not prompts, definitions, credentials, or approvals.
- Restoring a Blobby context does not start work or restore approval. Recheck an unstarted context before approving it. Once started, resume the saved repair and inspect its existing outcome; do not rebaseline or resubmit it.
- Origin, active-instance, and vault changes invalidate local repair state, and late responses cannot restore old approvals.
- Legacy history stays readable. Old approvals, publication controls, and generic model-job retries cannot execute the retired workflow.
- **Check saved run** rereads the persisted outcome. An uncertain response must never trigger an automatic repeat of branch creation or writes.
- **Stop remaining work** is not rollback. Completed files remain on the review branch; partial preparation is reported as such.
- For native Blobby, **Close this handoff** closes local tracking only. It does not stop Blobby in Omni; finish or stop that work there and inspect the actual result. For API execution, **Request Blobby stop** requests cancellation, but the current iteration may finish and terminal inspection is still required. Neither action rolls back edits.
- **Export review and outcome report** contains topic/file actions and operation statuses without raw YAML, credentials, or opaque execution inputs.

## Acceptance boundary

Local unit/type/lint checks establish development confidence only. A separately authorized live pilot must still verify the branch contents, confirm the shared model is unchanged, exercise the Omni handoff, and test destination query and access behavior. Do not call the workflow production-ready solely because local checks pass.

## Superseded workflow

The former guided/advanced split, required physical table/column mapping, free-form in-app SQL editing, and OmniKit publication steps are retired. Earlier table-spelling and identifier-only correction packages retain their recorded differences and historical evidence; they do not become new Blobby approvals. The active standalone repair experience is the single Blobby flow above. Dashboard packages keep their own preparation boundary. Earlier observations and test results are not acceptance evidence for this replacement.
