# Issue tracker: GitHub

Issues and planning maps for this repository live in GitHub Issues under `AojdevStudio/hermes-satellite`. Use the `gh` CLI for normal operations.

## Conventions

- Create issues with `gh issue create`.
- Read issues and their comments with `gh issue view <number> --comments`.
- List and filter issues with `gh issue list --json ...`.
- Comment with `gh issue comment <number> --body ...`.
- Apply or remove labels with `gh issue edit`.
- Close issues with `gh issue close`.
- Infer the repository from `git remote -v` when operating inside this clone.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## Skill publishing

When a skill says to publish work to the issue tracker, create a GitHub issue. When it says to fetch a ticket, read the corresponding GitHub issue and its comments.

## Wayfinding operations

- **Map:** Create one issue labelled `wayfinder:map`. It holds the Destination, Notes, Decisions-so-far, Not-yet-specified, and Out-of-scope sections.
- **Child ticket:** Create a GitHub sub-issue of the map and apply exactly one of `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task`.
- **Sub-issue fallback:** If GitHub sub-issues are unavailable, add the ticket to a task list in the map and put `Part of #<map>` at the top of the child body.
- **Blocking:** Use GitHub's native issue dependencies. Add a blocker with `gh api --method POST repos/AojdevStudio/hermes-satellite/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-database-id>`. If dependencies are unavailable, add `Blocked by: #<number>` to the child body.
- **Frontier:** The frontier is the map's open, unassigned child issues with no open blockers. Preserve map order when choosing among them.
- **Claim:** Assign a frontier ticket to the driving developer before starting work.
- **Resolve:** Post the decision as a resolution comment, close the ticket, and append a one-line linked gist to the map's Decisions-so-far section.
