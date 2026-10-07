Real GitHub REST responses, saved as returned (2026-10-06) so tests meet the
API's real shapes instead of hand-written stubs. Re-capture with:

    gh api repos/MultiAgency/kanban-sandbox/issues/58 > task-issue-58.json
    gh api repos/MultiAgency/kanban-sandbox/issues/57 > job-issue-57.json
    gh api repos/MultiAgency/kanban-sandbox/issues/58/comments > task-issue-58-comments.json
    gh api repos/MultiAgency/near-agencies/pulls/139 > pull-139.json

`task-issue-58` is a board task claimed by `agency-builder`; `job-issue-57` is
its zero-deposit job; `pull-139` is a merged pull request.

`pull-156.json` is near-agencies#156 (`gh pr view 156 --repo
MultiAgency/near-agencies --json title,body,state,merged,mergedAt,baseRefName,
html_url,number,author`, trimmed to the fields the coordinator reads): its
body never closes #167. `issue-167-timeline.json` holds the one event that
mattered to #175 — the cross-reference #156's own merge-announcement comment
(https://github.com/MultiAgency/near-agencies/pull/156#issuecomment-6026900364,
posted 2026-10-07T02:13:03Z by `multi-agency`, naming #167) recorded on
#167's timeline, reconstructed from `gh pr view`/`gh issue view` since this
checkout had no access to `gh api`'s raw `/timeline` endpoint.
