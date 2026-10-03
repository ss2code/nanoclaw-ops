## Task scheduling (`schedule_task`)

For any recurring task, use `schedule_task`. This is the scheduling path — tasks persist across sessions and restarts, and support the pre-task `script` hook described below.

To inspect or change existing tasks, use `list_tasks` (returns one row per series with the stable id across all conversations handled by this agent) and `update_task` / `cancel_task` / `pause_task` / `resume_task`. Management actions are confirmed by the host only after a live task is changed; an error means no task matched. Prefer `update_task` over cancel + reschedule.

### Execution plane

`schedule_task` accepts `delegateTo: "errand-runner"` as the mechanical handoff trigger. Use it for stateless public web research, source extraction, comparisons, and other work that does not need Jeeves credentials or private state. At run time, the runner sends the task to Errand Runner before invoking Jeeves, so Jeeves does not duplicate the work; Errand Runner replies to Jeeves, which owns verification, final synthesis, document-hub publication, and delivery. Omit `delegateTo` (or set `delegateTo: "jeeves"` in `update_task`) for private/authenticated/state-changing work or tasks whose final judgment must stay in Jeeves. Prose such as "use Errand Runner" in a prompt is not a trigger.

Frequent recurring scheduled tasks — more than a few times a day — consume API credits and can risk account restrictions. You can add a `script` that runs first, and you will only be called when the check passes.

### How it works

1. Provide a bash `script` alongside the `prompt` when scheduling
2. When the task fires, the script runs first
3. Script returns: `{ "wakeAgent": true/false, "data": {...} }`
4. If `wakeAgent: false` — nothing happens, task waits for next run
5. If `wakeAgent: true` — claude receives the script's data + prompt and handles

### Always test your script first

Before scheduling, run the script directly to verify it works:

```bash
bash -c 'node --input-type=module -e "
  const r = await fetch(\"https://api.github.com/repos/owner/repo/pulls?state=open\");
  const prs = await r.json();
  console.log(JSON.stringify({ wakeAgent: prs.length > 0, data: prs.slice(0, 5) }));
"'
```

### When NOT to use scripts

If a task requires your judgment every time (daily briefings, reminders, reports), skip the script — just use a regular prompt. Do not attempt to do things like sentiment analysis or advanced nlp in scripts.

### Frequent task guidance

If a user wants a task to run more than a few times a day and a script can't be used:

- Explain that each time the task fires it uses API credits and risks rate limits
- Suggest adjusting the task requirements in a way that will allow you to use a script
- If the user needs an LLM to evaluate data, suggest using an API key with direct Anthropic API calls inside the script
- Help the user find the minimum viable frequency
