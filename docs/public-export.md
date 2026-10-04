# Maintaining the public source export

This repository started as a reviewed source snapshot with a new Git history.
It must never receive the history of a private installation or a merge from a
private remote. Keep private deployments, instance data, and public source in
separate repositories.

For a later update:

1. Choose an exact reviewed source revision. Export only tracked source files
   into a separate temporary directory. Initialize a new review checkout;
   do not copy `.git`, ignored data, group workspaces, logs, host configuration,
   credentials, or local overlays.
2. Review the complete exported path list, including symlinks and binary
   assets. Remove instance-specific scripts, templates, documents, fixtures,
   machine names, contact identifiers, and operator settings. Check that
   every symlink resolves inside the export root. Keep the reviewed
   `container/AGENTS.md` runtime contract when exporting the Codex provider;
   installation verification must fail if that file is absent.
3. Review workflow triggers and permissions, install scripts, license notices,
   mounted paths, credential paths, and network defaults. Run independent
   secret scanning and the repository PII lint on the final source tree.
4. Install from frozen lockfiles with the supported Node and Bun versions.
   Run formatting, host/container/Ops Center typechecks, host and container
   suites, Trip Companion skill suites, and production dependency audits.
   Record any check that cannot run; a passing audit is not a substitute for
   runtime verification.
5. Capture demos from an isolated installation with fictional data. Inspect
   the finished media, captions, metadata, and stills for personal content.
   Remove the temporary runtime data and processes after capture.
6. Compare the intended staged file list with the actual one. Confirm the
   public checkout has only the intended public history and the private
   repositories retain private visibility. Commit and publish only after
   an independent reviewer approves the source and media.

Do not use `git merge`, `git push --mirror`, or a visibility toggle to update
this repository from a private installation. Import reviewed file changes or
prepare another audited snapshot instead.
