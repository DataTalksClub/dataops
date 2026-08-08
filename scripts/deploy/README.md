# Sponsor CRM GSI deployment gates

The Sponsor CRM index migration and the normal application deployment are two
separate workflows.

`migrate-sponsor-crm-gsis.yml` is a manually dispatched migration with no
GitHub Actions job environment. When later authorized under #136, only
`alexeygrigorev` on exact `DataTalksClub/dataops` `main` may run it. Without a
job environment it uses the existing deployment role and its exact usual OIDC
branch subject `repo:DataTalksClub/dataops:ref:refs/heads/main`; it requires no
environment subject, extra trust subject, environment secret or variable, or
environment approval path. It retrieves the last successful processed
`dataops-v1` template, compares it with the live retained Sponsor CRM table, and
adds the four canonical indexes one at a time. Each stage uses one exact
CloudFormation change set and waits for the table and new index to become fully
active before continuing.

The migration enumerates active change sets to exhaustion before creation and
execution. It rejects pagination cycles, unrelated candidates, changed IDs,
wrong templates, changed parameters or capabilities, role or notification
overrides, nested-stack inclusion, replacement, unexpected resource changes,
prefix gaps, and ambiguous backfill state. An interrupted run may delete only
one exact, still-unexecuted candidate from a bounded numeric prior run/attempt
with the same repository, ref, commit, StackId, baseline, stage, template, and
full CloudFormation request binding. It then requires the paginated inventory
to become empty and creates a fresh current-run candidate. Immediately before
deleting the prior candidate, it repeats the full old-prefix retained-state
proof, paginated singleton inventory, immutable-ID Describe, closed request,
change list, and Processed candidate-template validation; any late ambiguity
blocks without deletion. Immediately before
executing the pinned immutable change-set ARN, it re-reads the exact
stack/resource, processed baseline, live prefix, and retained table snapshot,
then performs the final list, describe, and processed-template checks. After
every stage it verifies that the table ID, ARN, base keys, billing, encryption,
backup status/configuration, TTL, stream, tags, retention, and CloudFormation
resource identity are unchanged. The first observation pins ARN and TableId
before an interrupted-transition waiter, and every waiter observation must
retain them. The complete Processed template must equal the initial full
baseline plus only the canonical cumulative stage deltas; unrelated same-prefix
template drift is never adopted. Advancing PITR earliest/latest restoration
timestamps are observational clock values and are the only backup fields
excluded from comparison. Completion performs every final stack, resource,
Processed-template, table, PITR, TTL, and tag read first; its fully paginated
empty change-set inventory is literally the last AWS read before success.
Uploads and subprocesses are bounded and cleanup targets only the exact staged
template object owned by the run.

`deploy-dataops-v1.yml` remains the sole application deployment workflow.
Immediately after OIDC credentials, before the deployment build or any
packaging/upload/deploy operation, it runs the separate read-only
`sponsor-crm-gsi-guard.mjs`. The guard verifies the exact account, role, region,
stack, logical resource, physical table, DynamoDB ARN and table ID, canonical
CloudFormation ownership tags, and requires all four named indexes with their
canonical keys and projections to be `ACTIVE` with no backfill. The guard does
not require TTL or streams to be enabled because the normal SAM deployment may
add them. It requires an observed TableId to be well formed but does not compare
TableId across workflows. StackId, logical/physical resource identity, the
derived DynamoDB ARN, and canonical CloudFormation system tags are the
cross-workflow replacement boundary. An incomplete or malformed table fails closed with
`dispatch-migrate-sponsor-crm-gsis`; the deployment build has not begun. Once
the guard passes, the existing build and `sam deploy` command run unchanged.

The migration workflow has no SAM package/deploy or final application
change-set path. The deployment guard contains no mutation operation. Do not run
either script locally against sandbox operational data or call `UpdateTable`.
Issue #145 authorizes no dispatch: #143 must first establish the Sponsor table
ownership boundary, and #136 must then pass its fresh Architecture, Security,
and HUMAN pre-dispatch gates before the migration workflow or the following
normal application deployment may run.
