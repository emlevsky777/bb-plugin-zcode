---
name: zcode-provider
description: Use ZCode Provider in bb, inspect its settings and sign-in, and recover an uncertain native session without blindly repeating a request.
---

# ZCode Provider in bb

Plugin/provider ID: `zcode-provider`. Use a fresh installation and new threads;
v0.1.x `zcode` threads/settings are not migrated.

Runs installed ZCode Desktop on macOS with the selected individual Z.ai Coding
Plan or Start Plan. Start is included in v0.2.2 and later; older v0.2.1
installations remain Coding Plan only.
Use Full permissions. Models and reasoning levels come from the installed
native catalogue; unavailable selections have no automatic fallback.

Use `bb plugin list --json` to find this plugin's installed ID, then
`bb plugin config <id>` to inspect settings. `authMode=desktop` (default) reads existing
Desktop sign-in in the real HOME. Choose a labelled Start Plan model
(`start-plan/GLM-5.3-Flash`) or an unchanged Coding model ID in each thread.
There is no global accountPlan setting. Start entries appear only while
entitled; key mode offers Coding models only.
Start requires `desktop`, reads the shared JWT fresh and skips the Coding Plan
project-token exchange. Only entitled native models are exposed; a valid
non-secret entitlement snapshot follows its scope/boundaries; amount and
availability and both Usage views share a host-wide 60-second demand cache,
including manual UI reloads (bb does not pass their reason to the bridge).
There is no background offer polling. **Check for Start Plan promotions** is
off by default and controls marketing reads and their notices only. Already
claimed quota, model discovery and Usage still work when off. An in-flight
request can finish. When enabled and absent, catalogue discovery reads English
(`en-US`) Desktop marketing deliveries with a shared ten-minute cache. A GET
may consume a server-side banner impression; this is unverified until the next
real promotion. Only a selected
claim_zcode_plan action can produce new-thread guidance; static product ads do
not. Open/update-if-needed ZCode Desktop, review eligibility and claim there,
then refresh the catalogue (allow up to one minute). An offer never proves a
grant, guarantees claim success or authorizes a model. Usage/rendering add no
offer queries. No claim/report/action POST, asset fetch or claim setting exists.
Provider Usage shows remaining/total tokens, used percent and expiry; bb calls
the date a reset, while the Start label clarifies expiry. Coding quota is not
shown. Enable bb's builtin Provider usage plugin to display its settings/sidebar card.
A successful balance without a promotion shows "No active Start Plan promotion ·
Coding Plan is separate" with no quota windows. M5.12 observed this after the
real deadline, rejected a stale Start ID and completed a Coding turn; warm
Start deadline crossing and positive Start generation on that revision remain unproven.
Native background memory extraction also consumes Start tokens; Desktop
memory preference and the existing fallback control it.
After promotion expiry, bb's next successful catalogue refresh removes Start
entries; its composer can choose the available default. Check the model before
sending. A directly requested unavailable Start ID fails without plugin fallback.
`coding-plan-key` uses `backupKey` from
bb's secret setting for the Coding Plan gateway. Never print or commit keys,
tokens, session stores or raw recordings. Native ZCode may refresh its shared
sign-in. The plugin does not write user configuration.

`subagentsDisabled` controls native agents; `memoryEnabled` is a fallback
when Desktop has no readable memory preference. Desktop memory takes
priority. Changed execution settings and the selected model's plan apply on the next ordinary turn;
steering keeps the active turn's settings.

Append instructions and bb-only skill metadata are delivered once to a native
session. Read bb-only skills by their exact SKILL.md paths with the file tool;
they are not registered in native Skill. Updated instructions/skills apply
to a new session. System instruction replacement is unsupported. Context
After automatic compaction the remainder of that turn can run without the full
bb instruction/skill block. The next ordinary turn restores it once. Continuous
preservation within the compacted turn is unsupported; automatic guide
reinjection is not enabled.

Complete shared Z.ai sign-in in Desktop. For Coding Plan the plugin refreshes project tokens
in memory, not the stored OAuth/business token. If sign-in is rejected, open
ZCode Desktop and sign in again, then retry after checking the previous
outcome. Merely opening Desktop is not a verified automatic token refresh.
If a request times out or its
outcome is unknown, inspect `bb thread show <id> --json`,
`bb thread log <id> --all --json`, native history and local artifacts before
resubmitting. Keep the original native session identity for cold resume.
Never blindly repeat an uncertain send. `bb zcode-provider-report` (or `--json`) prints a
server-local problem report, not diagnostics of a remote agent host. It uploads
nothing; credential-file presence does not establish usable sign-in. Record thread/session IDs, the action, observed result and
artifact paths; distinguish confirmed success from `not_proven`.

For native behavior, locate ZCode Desktop and read the installed guide rather
than relying on a copy. On the verified installation its configuration guide
is `/Applications/ZCode.app/Contents/Resources/glm/packages/zcode-guide-plugin/skills/zcode-configuration-guide/SKILL.md`.
The sibling `diagnosing-skills`, `diagnosing-commands`, `diagnosing-mcp`,
`diagnosing-hooks` and `diagnosing-plugins` directories contain their guides.
If Desktop is elsewhere, resolve the same paths under its actual bundle.

Unreleased M5.17 candidate reports current native context use and selected
model capacity in bb's standard estimated context indicator. Published v0.2.3
does not include it. It is separate from Provider Usage account quota and
cumulative turn/session tokens. Native accounting updates it after model work,
on model changes, compaction and cold hydration; streaming text does not imply
a fresh token count. Unknown use/capacity stays unknown. Every successful compact
clears use until main-request accounting; its messages-only native estimate is
not displayed as full context, including after cold hydration. A zero after
native history is unknown; a supplied zero is retained only for an empty session.
Use `bb thread context <thread-id> --json` to read bb's latest stored pair
without a model request. Do not infer exact billing or live automatic-compaction
coverage from the meter.

Unreleased M5.16 candidate exposes BB plugin tools by default via an
attachment-owned MCP HTTP endpoint. Published v0.2.3 does not include this.
Configured native MCP remains native-owned: the explicit list includes exact
CLI user/project declarations plus BB tools, while native retains plugin and
built-in discovery and trust. Effective disabled servers, unreadable/invalid
configuration or settings outside the reader's verified coverage select a
per-session fallback with a clear notice, no explicit list and no BB tools.
Native-written UI locale and plugin enabled/options/suppressed settings have
source-backed shape coverage and do not alone trigger fallback. They stay
native-owned and are not applied by this reader. Other uncovered settings
select fallback, leaving native behavior unchanged.
Never replace this with a bb-only list or reactivate disabled-name collisions.
Cold resume rebuilds the endpoint; steering keeps the active catalog. Stop,
release and disconnect cancel pending BB calls without replay. The endpoint
uses open `127.0.0.1` without a token, as selected by the owner, and refuses
requests carrying `Origin`. Its name is stable across cold resume, with a
deterministic suffix if an effective configured MCP name collides. Image transport
does not prove model image perception; native subagent forwarding is unverified.

No fork, plan mode, fast service tier or automatic Desktop installation/update.
Native skill/command menus retain native names and file links.
