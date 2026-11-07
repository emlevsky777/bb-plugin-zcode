# ZCode Provider for bb

Run your installed ZCode coding agent inside [bb](https://getbb.app) with an
individual Z.ai Coding Plan: files, terminal tools, native skills and commands.
[Russian edition](README.ru.md).

This early unofficial plugin is unaffiliated with Z.ai, ZCode or bb. The plugin
uses your installed ZCode to send model requests; the bridge also calls Z.ai
to obtain short-lived project tokens for shared Desktop sign-in. You are
responsible for complying with your Coding Plan terms. Version in this tree:
`v0.2.3`. See [release notes](RELEASE_NOTES.md) and
[published releases](https://github.com/emlevsky777/bb-plugin-zcode/releases).
The source repository is public.

**v0.2.3 preserves bb's explicit thread environment** in native tools, including
project, environment, storage and CLI connection metadata. This corrects a
case where `bb status` found the thread but returned no project. Inherited
process cleanup and the real HOME/shared Desktop store remain as before.

**v0.2.2 adds labelled Start Plan models**
alongside Coding Plan models. Both native Provider Usage views show independent
Coding Plan quota percentages/reset times and Start token/expiry or absence.
Demand reads are shared; refresh may reuse a snapshot for up to one minute.
See the [release notes](RELEASE_NOTES.md). The selected model determines each
thread's plan. Existing v0.2.1 installations remain Coding-only until updated.
Start uses the current ZCode Desktop sign-in and exposes only entitled native
models. The plugin never substitutes a Coding model for a requested Start ID;
bb's composer can select an available default after catalogue removal (see below).
The native check observed GLM-5.3-Flash with low/high/max and native max default
on Desktop 3.17.2 / CLI 0.17.1. On 6 November 2026 a real pending-to-active Flash
promotion, a completed Start-gateway turn and a reported token debit were
verified. An earlier post-expiry absent promotion, rejected stale Start ID and
completed Coding turn were also observed. A warm Start session's actual expiry
transition remains unproven. Native retries and project-memory extraction are
included in the activation series; the last extraction request followed the
last measured balance, so neither full-turn nor exact per-input cost is proven.

v0.2.0 uses a distinct identity: **ZCode Provider**, package
`bb-plugin-zcode-provider`, plugin/provider ID `zcode-provider`. Users of our
v0.1.x line must install this source afresh and create new threads. After
verifying the new installation, disable the old `zcode` installation through
Settings. Its settings, secrets, sessions and history are not migrated; old
threads are unsupported by the new provider. Existing `^0.1.0` installations
stay on that line. This is separate from other authors' ZCode plugins.

## Requirements and installation

Requires macOS on Apple silicon, bb 0.47.1 or newer, installed ZCode Desktop,
Git (Xcode Command Line Tools) and an individual Coding Plan login. bb supplies host Node and
build tools; Python, Homebrew and global npm are unnecessary.

In bb, open **Settings → Installed plugins** (Plugins), then **New plugin
options → Install from source**, and paste:

```text
git:https://github.com/emlevsky777/bb-plugin-zcode.git@^0.2.0
```

Review and confirm. This source selects stable versions in the `^0.2.0` range.
The same installation is available in bb's terminal:

```sh
bb plugin install git:https://github.com/emlevsky777/bb-plugin-zcode.git@^0.2.0
```

bb builds both server and host bundles. Plugin and provider ID: `zcode-provider`. Open a thread, select
**ZCode Provider**, a model (GLM-5.3 when available), permissions **Full**, and send a
message. bb permissions govern tool access; review commands and project trust.

Complete the first individual Z.ai Coding Plan sign-in in ZCode Desktop.
Leave **ZCode sign-in source** at `desktop` (the default).
The plugin reads that shared sign-in and refreshes short-lived project tokens
in memory; it does not refresh the stored OAuth/business token. If the server
rejects that token, open Desktop and sign in again, then retry in bb. Merely
opening Desktop is not a verified automatic refresh mechanism. The stored
token's lifetime and real expiry behavior have not been measured; rejection
and recovery are tested offline. The next request reads changed sign-in
without restarting bb. `zcode` need not be on PATH. Spotlight locates renamed bundles;
fallback search uses `/Applications` and `~/Applications`. System Applications
is preferred when multiple copies exist.

Stop every ZCode thread with its **Stop** button before updating or removing.
Open **Settings → Installed plugins → ZCode Provider** to review and apply an offered
update. To remove it, choose **ZCode Provider actions → Remove from bb**. Updates follow
the recorded source and stable range. Exact tags and commits are pinned;
changing source requires removal and fresh installation. Removal clears settings, secrets and schedules,
while bb 0.47.1 retains plugin session data.

Optional CLI route: in the bb thread's right panel, choose **Open new tab →
Start terminal**. bb provides
its CLI there; your system Terminal does not need a `bb` command:

```sh
bb plugin outdated
bb plugin update zcode-provider --yes
bb plugin remove zcode-provider
```

Removal unregisters the plugin and deletes its settings, secrets and schedules.
bb 0.47.1 removes unused managed Git artifacts; plugin data and downloaded host
artifacts can remain. With the default bb data directory, relevant paths are:

- `~/.bb/plugins/cache/git/github.com/emlevsky777/bb-plugin-zcode/<commit>/`
  — the checkout and built bundles for the installed commit.
- `~/.bb/plugins/zcode-provider/` — plugin data, including `host-data/` and `bridge-data/`.
- `~/.bb/plugin-host-artifacts/zcode-provider/` — downloaded host bundles.

For optional complete disk cleanup, copy the exact **Source** path from plugin
details **before** removal. In bb's terminal, `bb status --json` reports `dataDir`;
if it differs from `~/.bb`, use that directory in the paths below. Stop every
ZCode thread, including background work, then choose **Remove from bb**.
Only after that, remove the exact retained directories manually:

```sh
# Replace <commit> with the checkout ID recorded before removal.
rm -r -- "$HOME/.bb/plugins/cache/git/github.com/emlevsky777/bb-plugin-zcode/<commit>"
rm -r -- "$HOME/.bb/plugins/zcode-provider"
rm -r -- "$HOME/.bb/plugin-host-artifacts/zcode-provider"
```

Remove a checkout only when no other installed plugin uses it; do not delete the
whole bb Git cache. Manual data removal discards plugin-local session data and
caches, so those native sessions can no longer be resumed. Neither plugin removal
nor this cleanup touches your ZCode Desktop login/history or bb thread history.
Save needed settings first; never put secret values in a chat or issue.

## Capabilities and limits

- Account model catalogue and supported reasoning levels. Missing explicitly
  selected models or efforts fail without substitution.
- Continuation, foreground stop, context compaction, guidance during
  an active turn, and subagents with bb's setting enabled.
- Native ZCode skills and bb-only skills. Native skill/command menu selection
  on this release base is not live-verified. The implementation accepts one
  native command per message; new resident skills may require a new thread.
- bb append instructions and bb-only skills are delivered once per native
  session, including cold resume. Skill metadata uses exact `SKILL.md` paths;
  read bb-only skills with the file tool. They are not registered in native
  Skill. Canonical files and names already discovered by native ZCode are
  excluded. Changed instructions/skill roots apply to a new session; they do
  not recreate an existing session. System instruction replacement is unsupported.
- PNG/JPEG/GIF/WebP images up to 10 MiB, inline image data, and UTF-8 files up to
  256 KiB. PDF, binary files and remote image URLs are rejected.
  Image interpretation depends on the native model: in the checked combination,
  GLM-5.3-Flash transcribed an attached table without tools, while GLM-5.3 reported
  seeing only its path in both bb and ZCode Desktop. Direct image perception is
  not established for GLM-5.3; attachment acceptance alone does not prove it.
  A checked tool-assisted GLM-5.3 result used native Read followed by ZCode's
  image analyzer.
  Planned, not yet available: PDF attachments, larger text files and other
  formats. No delivery date is promised.
- Real HOME and the shared ZCode Desktop store: personal/project instructions,
  standalone skills, enabled native plugins and configured MCP servers. bb keeps
  its own session database and history and logs. `ZCODE_DATA_BASE_DIR` is not
  set: native ZCode uses Desktop's `~/.zcode/v2` sign-in store directly and may
  refresh tokens, just as Desktop processes do. The plugin itself
  does not write `~/.zcode/cli/config.json` or Desktop settings.
- Memory follows the boolean in Desktop's `~/.zcode/v2/setting.json`. If it is
  absent, invalid or unreadable, **ZCode memory fallback** applies (default ON).
  Memory and subagent changes apply to the next ordinary turn; steering retains
  active settings. Other Desktop runtime preference fields are not imported.

After successful context compaction, the next ordinary turn checks active
native history and restores the original bb block once if it was folded away.
Native automatic compaction can make an internal model request before this
hook; the remainder of that turn can run without the full bb block. Continuous
instruction/skill preservation within that turn is unsupported.
The G4 experiment found that native guide restores the block in request two
when no earlier user guide is pending, but in request three when a user guide
precedes it. It also produces a visible assistant response to the service block.
Automatic guide reinjection is therefore not enabled.
There is no provider-specific 64 KiB instruction or skill-file limit. The
attachment limits above apply only to uploaded attachments.

MCP configuration is loaded at session creation. After adding a server in
Desktop, use a new bb thread or stop and cold-continue the existing thread.
Complete the first MCP OAuth sign-in in Desktop; initiating it inside bb is
not established. An individual server's startup failure remains in diagnostics
and `bb zcode-provider-report`, without a conversation warning or blocking ordinary
input. Configured hooks follow native enablement and trust rules; no configured
hook was available for the B-2 live check. Precise native denylist patterns are
not guaranteed (`Bash(echo:*)` excluded all Bash; `Agent*` did not exclude Agent).

Guidance queued by ZCode can be lost on disconnect/resume and is not replayed.
It retains the active turn's account plan, model, reasoning, login mode, memory and subagent
settings; changed options
apply to the next ordinary turn. Uncertain submissions are not automatically
resent. Check the thread before retrying. Service failures show reason/code;
inspect bb's pending retry before sending again. Cold continuation and recovery
reuse the saved native session; an unknown input outcome needs reconciliation,
not a blind replay. Use `bb zcode-provider-report` for a shareable diagnostic summary.

An optional **Backup Coding Plan key** belongs only in the protected plugin
setting. Explicitly select `coding-plan-key`; there is no automatic switch from
Desktop sign-in or to pay-as-you-go API. A changed source applies to the next ordinary
input; active work and steering retain their selected source.
Server-side quota accounting for key mode has not been established.

Entitled models such as
**GLM-5.3-Flash · Start Plan** appear alongside Coding Plan models, with distinct
bb IDs (`start-plan/GLM-5.3-Flash`). Select the model in each thread; no global
plan setting is needed. Use `authMode=desktop`: key mode offers Coding models
only, and a directly requested Start/key combination is rejected. Start reads
the shared Desktop JWT fresh, without the Coding Plan project-token exchange.
An ordinary model change changes the plan; steering retains the active plan.

**Provider Usage** shows Start tokens remaining/total, the percentage used and
the expiry time. Enable bb's built-in **Provider usage** plugin if disabled,
then open its settings or sidebar card. The native bb surface calls its date a reset; the Start label
identifies it as access expiry. Catalogue and Usage access share a balance read
across threads and both Usage views, with a 60-second freshness interval. A
manual UI reload also uses this interval because bb does not forward its refresh
reason to the provider bridge. No
background quota polling or additional model retry loop is added. A separate
Coding Plan resource shows five-hour/weekly percentages and supplied reset
times, independently of Start and the selected model. Missing promotion, missing sign-in and unavailable amounts are
reported separately. A successful balance without a promotion shows
"No active Start Plan promotion · Coding Plan is separate" with no quota windows.
A claimed future grant shows pending activation and its reported start time,
without offering a Start model early. If no balance bucket exists yet, grant
units are not presented as an available/remaining balance. Claimed pending or
exhausted grants suppress Claim-again guidance as well as offer discovery.
After the reported start, a claimed plan with no reported balance remains
labelled as claimed with its quota balance not yet reported; it is not shown
as an absent promotion. Model access in that real state still needs native
activation verification.
Native background memory extraction also consumes Start
tokens; Desktop memory preference and the existing fallback control it.

The plugin setting **Check for Start Plan promotions** is off by default.
When enabled and Start is absent, catalogue discovery reads Desktop's current
marketing deliveries in English (`en-US`), shared and cached for ten minutes.
When off, neither marketing requests nor their notices occur; balance, claimed
Start models and Usage remain available. A request already in flight can finish.
In one real campaign the Desktop banner and Claim remained after one bb GET
and an owner Desktop refresh. Server impression/frequency-cap effects remain
unknown; concurrent Desktop touches prevent attributing all effects to bb.
Only a selected `claim_zcode_plan`
action can cause a native notice in a new Desktop-auth thread. A static product
advertisement does not. Open ZCode Desktop, update it if needed, review your
eligibility and claim there, then refresh the bb catalogue (allow up to one
minute). An offer is not a granted balance or a guarantee of successful claim.
The plugin never claims automatically, reports marketing actions or downloads
campaign assets. Rendering and Usage add no offer queries; no background offer
polling is added. Discovery failures mean unknown, not absence of a promotion or
Coding Plan. This support is included in v0.2.2; v0.2.1 remains Coding-only.

Start models leave the catalogue at its next successful refresh after access
expires or a fresh balance confirms no available tokens. bb can retain a stale
catalogue on refresh failure, and its composer can select the default available
model when the old one disappears: check the model before sending after a
promotion ends. The plugin rejects a directly requested unavailable Start ID
and never substitutes a Coding model. Earlier revocation can first be detected
by server rejection. After activation, bb may first return its stored model
list while refreshing it in the background; reopen the picker once if needed.

## Compatibility

Statuses describe observations, not guarantees for later versions.

The plugin-owned zod copy is 4.6.6. bb's separate zod 4.6.5 copies remain an
external limitation; this patch does not update bb-owned dependencies.

| Configuration or capability | Status |
| --- | --- |
| macOS arm64; bb 0.49.0, installed SDK 0.6.132 (declared 0.6.79), host Node 24.22.2; Desktop 3.17.2 / CLI 0.17.1 | Limited v0.2.3 representative check: Desktop-sign-in Flash/high/Full file/terminal task with bb CLI project/thread context, and cold continuation. Installed-source retry and native-history tests pass. No new level1 tuple, automatic-compaction result, expiry transition or broader feature matrix is claimed. |
| macOS arm64; bb 0.48.1, installed SDK 0.6.104 (declared 0.6.79), host Node 24.22.0; Desktop 3.17.2 / CLI 0.17.1 | Limited v0.2.1 representative check, accepted 5 November 2026: Desktop sign-in, Flash/high/Full file/terminal task, cold resume, successful manual compact and one full frozen bb block in the actual next ordinary request. Native history fixtures compare reviewed 3.16.3 and 3.17.2 functions. Live leading-ID occurrence and successful automatic compaction remain unproven. This series does not register a new level1 tuple or repeat the broader feature matrix. |
| macOS arm64; bb 0.48.0, installed SDK 0.6.94 (declared 0.6.79), host Node 24.22.0; Desktop 3.16.3 / CLI 0.17.0 | Checked level1 combination, accepted 29 October 2026, including ordinary recovery after active Stop. Desktop OAuth, representative models, cold resume, memory/steer, manual compaction, local-file attachment and native question verified. Successful automatic compaction remains unproven; its remainder-of-turn instruction limit still applies. These native-runtime observations are retained from v0.1.x; v0.2.0 requires fresh installation. [Observed identities](compat/M5.4-artifacts.json). |
| macOS arm64; bb 0.47.1, SDK 0.6.79, host Node 24.22.0; ZCode Desktop 3.15.1 / CLI 0.16.9 | Checked level1 combination, accepted 26 October 2026. Git omit-dev installation and shared Desktop sign-in work with GLM-5.3 and GLM-5.3-Flash. Native Notion reading passes; the known page is blank. [Artifact identities](compat/M4.9.8c.1b-artifacts.json). |
| Earlier bb/SDK/engine combinations | Historical results remain in their reports; this release does not retain old-runtime support. |
| Later bb/ZCode versions; individual plans other than Lite | Pending verification |
| Start Plan | v0.2.2: real pending-to-active Flash pickup, completed Start-gateway turn and token debit verified; post-start access without a balance bucket remains unproven |
| Windows, Linux, Intel macOS; Team Coding Plan, off-peak, BigModel | Unsupported |
| Browser Use | Unsupported: native interaction rejected on the earlier verified base; no new support is claimed |
| Computer Use; backup-key server quota accounting | Not established |

Unchecked combinations show a notice and may fail to start or run. Do not rely
on Browser/Computer Use through this provider. [Offline compatibility inspection](compat/README.md)
finds bundle changes; textual matches alone do not prove compatibility.

## Trust boundaries

bb plugins run as full-trust code with your account's access on server and
host. Review this repository and installed ZCode before enabling it. The provider
starts ZCode's CLI using its Helper; ZCode controls model requests, tools and
network connections. Project content and prompts can leave through ZCode as in
direct use. The plugin adds no separate model endpoint or report upload.

The plugin reads the shared ZCode login; native ZCode may refresh its tokens.
For OAuth sign-in the bridge resolves native project access tokens in memory
through Z.ai's account API; it does not write credentials or user configuration.
bb sessions keep separate data/history
and do not appear in Desktop. The plugin writes session bindings, native data,
caches and diagnostics under its bb data directory. Builtin and personal provider
configurations are selected by native ZCode in place; the plugin keeps no copies.
The app-server still needs a host account overlay and runtime headers, as in Desktop.
Background task cards and checkpoints retain the full native command, including
arguments. An unconfirmed input is reported without resending it or killing the
native process on the confirmation timeout; reconcile its outcome before retrying.
Original personal/project settings and skills are read in place. Optional native
plugins may run hooks in both Desktop and bb; enabling them expands the code you
trust. Native tools run with full access to the real HOME and environment.

The diagnostic observer is inactive without explicit configuration of an owned
loopback proxy and certificate. Local reports exclude prompts, workspace content
and credential values. Diagnostic journals rotate, but native history and host
caches have no hard total size cap. Never publish the data directory, raw native
logs, credentials or authorization links.

## Reporting a problem

In a bb thread's right panel, choose **Open new tab → Start terminal** and run
`bb zcode-provider-report` (text), `bb zcode-provider-report --json`, or `bb zcode-provider-report --help`.
bb supplies the CLI in this terminal; no system PATH setup is needed.
The report is **server-local**: it describes the bb server's installation and
diagnostic events, not a remote agent host or the invoking terminal's directory.
It excludes personal paths and session contents. Credential-file presence is
reported separately from sign-in readiness, which is not checked. Exit codes:
0 success/help, 1 collection failure, 2 invalid arguments; JSON failures use
`{ok:false,error:{code,message}}`. Nothing is collected for help or invalid argv.
Attach its reviewed output to a
[GitHub issue](https://github.com/emlevsky777/bb-plugin-zcode/issues), with steps,
time/timezone and exact error. It uploads nothing. With multiple installations,
use `bb plugin run zcode-provider` explicitly. Server logs: `bb plugin logs zcode-provider`.

## Development and license

On supported host Node: `npm ci`, `npm run typecheck`, `npm test`.
`bb plugin build` produces server and host artifacts. Tests are offline with
synthetic fixtures and do not spend Coding Plan quota.

[Apache-2.0](LICENSE). Adaptations are attributed in [NOTICE](NOTICE) and
[the upstream license](LICENSES/Apache-2.0.txt).
