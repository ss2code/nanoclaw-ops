# Tutor CLI policy

Use `bun /workspace/agent/tutor-app/app/cli.ts help --json` for the role-filtered command catalogue and its complete flag usage. For one command, use `bun /workspace/agent/tutor-app/app/cli.ts <area> <verb> --help`; never guess aliases.

- `context current|frontier`: resolve the actor and bounded state.
- `course search`: retrieve provenance-bearing snippets and attach them to the turn trace.
- `instruction list|search|propose`: list or reuse concept-tagged resources; students see approved shared items, tutors also see proposals, and a generic student-created diagram must be proposed for tutor review rather than silently published class-wide. Use inline text for normal Telegram teaching and the returned `preview_path` with `send_file` to resend a full HTML/PDF/diagram material in the current channel.
- `learning plan-action|record-attempt|mastery|misconception|set-action|complete-action`: select and persist evidence-backed teaching state.
- `trace timeline|metrics`: inspect routing-scoped intermediate state and learning velocity.
- `memory remember|recall`: use the per-student learning-memory overlay.
- `inbox apply`: apply only commands addressed to the current student.
- `ingestion inspect|propose|commit` and `ckg show`: tutor-control curriculum operations. Intake supports Markdown/text/HTML, native or scanned PDF, common images, DOCX, and PPTX; choose an explicit OCR provider for scanned material and review the returned status before proposing. `ingestion source-list|source-get` exposes only approved, root-contained source/artifact paths; students do not receive uploader identity or superseded revisions.
- `schedule review-add|list|pause|resume|cancel|delivery-receipt`: current-student schedule authority.
- `profile current|preferences`: current-student preference authority, including coaching setup markers and timezone preference.
- `coaching briefing|schedule-plan`: current-student progress card and the two-slot proactive coaching schedule contract.
- The general `schedule_task` tool creates the 07:00 and 15:00 recurring coaching wakes; keep each task in the current student session and wait for the host confirmation.
- `visual render`: deterministic accessible graph, process, comparison, or worked-example visual.
- `admin dashboard|report`: standardized detailed insight delivered in the same tutor-control messaging channel, with an optional report artifact; no Ops Center access is required.
- `admin blueprint-get|blueprint-set`: tutor-control assessment design and activation.
- `admin instruction-register|instruction-approve`: tutor-controlled reusable instruction repository publishing; approval promotes the artifact into shared `course/resources`, after which both roles can list it and resend its preview in-channel.
- `admin roster|export-profile-memory|intervention-command|assignment-command|guidance-command|policy-get|policy-set`: other tutor-control operations.

Never use raw SQL, arbitrary paths, or ad-hoc file edits for application state.
