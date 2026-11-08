# Task-group fit (Python half)

The per-trace half (sampling, summaries, embeddings, placement) is TypeScript, in
`frontend/worker/src/ee/task-groups/`. This half runs on the Celery worker and
meets that one only in ClickHouse: it reads `trace_task_digests`, and writes
`task_groups` and `trace_group_members`.

## One fit

`job.fit_project(project_id, trigger)`:

1. Stop if the project has the feature off, the deployment has no model key, or
   the window holds fewer than `fit.MIN_DIGESTS` (100) summaries. Below the gate
   nothing is claimed, so the first map builds itself the day it crosses.
2. Claim the run in Postgres (`task_group_fit_runs`). A daily run is unique per
   project and UTC day (partial unique index), so a tick that fires twice fits
   once; a refresh request is consumed by one claim. A failed daily run can be
   retried up to three times; a run stuck "running" for 30 minutes is taken as
   dead.
3. Read the last 14 days of summaries (newest 50,000), in trace id order.
4. `fit.fit_groups`: project to 64 dimensions (PCA), reduce with UMAP (cosine),
   cluster with HDBSCAN, then describe each cluster in the original cosine space:
   a unit-length **center**, and a **reach** (the 95th percentile of member
   distance, times 1.5, never above 0.7). A row HDBSCAN left out that lies inside
   its nearest center's reach is placed there, the same rule the per-trace
   placement uses.
5. `identity.match_groups`: a new cluster continues an old group when they share
   at least three traces and at least half of the old group's members or of the
   cluster's members that existed before. Matching is one-to-one, largest overlap
   first. A continuing group keeps its id, name and description.
6. `naming.name_group`: one model call per new group, from ten of its most
   typical summaries (fenced as data), asking for a short name and a sentence. A
   name already in use gets one more try with the used names listed.
7. Write memberships, then the groups. The groups row is what makes a fit
   current, so a half-written fit is never read.

`tasks.tick` runs every ten minutes on the Celery beat schedule and enqueues a
fit for each enabled project that has a pending refresh request or no daily run
today.

## Settings and why

Cluster size is 6% of the rows, between 10 and 300. UMAP uses 30 neighbours. These
come from a sweep over seven synthetic corpora (see the evaluation scripts in
`scripts/topic_corpus/`); smaller clusters split one task into several, larger
neighbourhoods merge neighbouring tasks.

