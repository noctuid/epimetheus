# Agent Feedback

- Avoid preserving obsolete internal data shapes under a vague compatibility rationale when no compatibility requirement was established. Remove dead fields and parameters when the new architecture makes them irrelevant. (count: 1)
- Put new changelog entries under `Pending`; do not add them to an already released version during conflict resolution. (count: 1)
- Validate the full documented domain for numeric settings, including whole-string parsing, integer requirements, and runtime-supported bounds; permissive parsing or incomplete range checks can silently produce unsafe values. (count: 2)
- Get the user's review before committing changes. (count: 1)
