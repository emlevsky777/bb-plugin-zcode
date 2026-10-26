---
name: zcode-provider
description: Use ZCode in bb, inspect its settings and sign-in, and recover an uncertain native session without blindly repeating a request.
---

# ZCode provider in bb

Runs installed ZCode Desktop on macOS with the individual Z.ai Coding Plan.
Use Full permissions. Models and reasoning levels come from the installed
native catalogue; unavailable selections have no automatic fallback.

Use `bb plugin list --json` to find this plugin's installed ID, then
`bb plugin config <id>` to inspect settings. `authMode=cli` reads existing
Desktop sign-in in the real HOME. `coding-plan-key` uses `backupKey` from
bb's secret setting for the Coding Plan gateway. Never print or commit keys,
tokens, session stores or raw recordings. Native ZCode may refresh its shared
sign-in. The plugin does not write user configuration.

`subagentsDisabled` controls native agents; `memoryEnabled` is a fallback
when Desktop has no readable memory preference. Desktop memory takes
priority. Changed execution settings apply on the next ordinary turn;
steering keeps the active turn's settings.

Append instructions and bb-only skill metadata are delivered once to a native
session. Read bb-only skills by their exact SKILL.md paths with the file tool;
they are not registered in native Skill. Updated instructions/skills apply
to a new session. System instruction replacement is unsupported. Context
After automatic compaction the remainder of that turn can run without the full
bb instruction/skill block. The next ordinary turn restores it once. Continuous
preservation within the compacted turn is unsupported; automatic guide
reinjection is not enabled.

Complete shared Z.ai sign-in in Desktop. The plugin refreshes project tokens
in memory, not the stored OAuth/business token. If sign-in is rejected, open
ZCode Desktop and sign in again, then retry after checking the previous
outcome. Merely opening Desktop is not a verified automatic token refresh.
If a request times out or its
outcome is unknown, inspect `bb thread show <id> --json`,
`bb thread log <id> --all --json`, native history and local artifacts before
resubmitting. Keep the original native session identity for cold resume.
Never blindly repeat an uncertain send. `bb zcode-report` (or `--json`) prints a
server-local problem report, not diagnostics of a remote agent host. It uploads
nothing; credential-file presence does not establish usable sign-in. Record thread/session IDs, the action, observed result and
artifact paths; distinguish confirmed success from `not_proven`.

For native behavior, locate ZCode Desktop and read the installed guide rather
than relying on a copy. On the verified installation its configuration guide
is `/Applications/ZCode.app/Contents/Resources/glm/packages/zcode-guide-plugin/skills/zcode-configuration-guide/SKILL.md`.
The sibling `diagnosing-skills`, `diagnosing-commands`, `diagnosing-mcp`,
`diagnosing-hooks` and `diagnosing-plugins` directories contain their guides.
If Desktop is elsewhere, resolve the same paths under its actual bundle.

No fork, plan mode, fast service tier or automatic Desktop installation/update.
Native skill/command menus retain native names and file links.
