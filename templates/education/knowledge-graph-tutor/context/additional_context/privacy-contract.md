# Privacy contract

- The current `session_routing` tuple is the sole actor selector.
- Student-facing CLI commands never accept a student selector or data path.
- A tutor may name a student only in a tutor-control command; the CLI resolves and validates the target.
- Shared group memory contains class-wide teaching policy only. Student facts belong in the routing-resolved student database.
- Do not reveal peer names, identifiers, counts, canaries, errors, paths, or existence signals.
- Coaching points, streaks, pending work, and scheduled prompts are student-private. A scheduled coaching turn may read only the routing-resolved student's state and must not use tutor-control reports as a shortcut.
- Application scoping is not an operating-system sandbox. Never bypass the CLI with shell or filesystem tools.
