---
description: Convert a plain task into a strict evidence-based pi-codex goal and create it
argument-hint: "<task>"
---

User task:
$@

Turn the user task into exactly one durable pi-codex-goal objective, then call the goal creation tool with that objective.

This prompt invocation is an explicit user request to set a new goal. When the goal creation tool exposes `replace_existing`, pass `replace_existing: true` so an existing active, paused, or budget-limited goal is replaced instead of requiring `/goal clear` first.

Do not set a token budget limit unless the user explicitly provides a budget/limit in the task. If no explicit budget is provided, omit the token budget field entirely. Explicit budgets must be integers of at least 500,000 tokens. If the supplied budget is smaller, ask for a valid budget or no limit instead of raising it or silently dropping it.

The goal must be a completion contract, not a task summary. Preserve the user's full intent. Do not weaken broad acceptance criteria such as "all", "any", "complete", "no tech debt", "do it right", "fully", or "hard acceptance criteria".

The goal must require:

1. Outcome
   - State what must be true when complete.
   - Preserve the full requested end state.
   - Do not narrow scope after the fact unless the original user task explicitly defined that scope.

2. Verification evidence
   - Name the concrete evidence required before completion.
   - Include relevant tests, lint, type checks, builds, smoke checks, diffs, docs, generated outputs, rendered UI inspection, or artifact checks when applicable.
   - If the repo has an existing local CI/validation command, require it unless clearly irrelevant.

3. Constraints
   - Preserve existing behavior unless the task explicitly changes it.
   - Do not discard user changes.
   - Do not leave unapproved shortcuts, compatibility shims, TODO placeholders, dead code, duplicated logic, hidden assumptions, or undocumented behavior changes.

4. Iteration policy
   - After each attempt, inspect evidence, update the plan, and keep taking the next low-risk useful step.
   - Do not stop at a plan when implementation or verification remains.
   - If validation fails, triage and fix the cause rather than reporting partial completion.

5. Completion audit
   - Before marking the goal complete, map every explicit requirement in the goal to fresh evidence from files, commands, diffs, tests, screenshots, artifacts, or logs.
   - The goal is not complete if any requirement is unverified, narrowed, deferred, or only probably satisfied.
   - Phrases like "for the scope this is complete", "good enough", "out of scope", or "remaining tech debt" are not valid completion evidence unless the original user task explicitly allowed that limitation.

6. Blocked stop condition
   - If missing user input or external work prevents meaningful progress, call `update_goal` with status `blocked` and a reason describing the dependency, then explain what is needed. Wait for explicit `/goal resume`; ordinary input does not reactivate the goal.
   - If completion is impossible with current access, tools, or budget, stop without marking complete.
   - Report attempted paths, evidence gathered, exact blockers, remaining unmet requirements, and what input would unblock progress.

Use concise imperative language in the goal. If the task is blank or only whitespace, infer the goal based on the conversation context or ask the user to clarify.
