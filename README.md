# ZCode Provider for bb

Run your installed ZCode coding agent inside [bb](https://getbb.app) with an
individual Z.ai Coding Plan: files, terminal tools, native skills and commands.
[Russian edition](README.ru.md).

The model picker uses your Desktop account's catalogue, including GLM-5.4
when available. Eligible Start Plan models appear alongside Coding Plan models.

Current tagged release **v0.2.4**. [Release notes](RELEASE_NOTES.md) ·
[Published releases](https://github.com/emlevsky777/bb-plugin-zcode/releases)

This unofficial plugin is unaffiliated with Z.ai, ZCode or bb. Use it in
accordance with your Coding Plan terms.

## Requirements and installation

Requires macOS on Apple silicon, bb 0.47.1 or newer, installed ZCode Desktop,
Git (Xcode Command Line Tools) and an individual Coding Plan login. bb supplies host Node and
build tools; Python, Homebrew and global npm are unnecessary.

In bb, open **Settings → Installed plugins** (Plugins), then **New plugin
options → Install from source**, and paste:

```text
git:https://github.com/emlevsky777/bb-plugin-zcode.git@main
```

Review and confirm. This source follows the public `main` branch.
The same installation is available in bb's terminal:

```sh
bb plugin install git:https://github.com/emlevsky777/bb-plugin-zcode.git@main
```

Sign in to your individual Z.ai Coding Plan in ZCode Desktop. In bb, leave
**ZCode sign-in source** at `desktop` (the default). Open a new thread, select
**ZCode Provider** (`zcode-provider`), choose GLM-5.4 if available or another
model from your account, and use **Full** permissions.
bb finds ZCode Desktop locally, so the `zcode` command need not be on PATH.

**First connection.** macOS may ask for your Mac login password in a Keychain
dialog. This gives bb access to the key that protects your existing ZCode
Desktop sign-in. If Z.ai rejects the saved login, sign in again in Desktop and
retry in bb. The next request reads the updated sign-in.

If you're upgrading from our v0.1.x line, install this source afresh and start
a new thread. [Migration details](RELEASE_NOTES.md#distinct-identity-and-fresh-installation).

Stop every ZCode thread with its **Stop** button before updating or removing.
Open **Settings → Installed plugins → ZCode Provider** to review and apply an offered
update. Installations that follow `main` get the latest commit on that branch
when you apply an update. To remove the plugin, choose **ZCode Provider
actions → Remove from bb**.

Existing `^0.2.0` installations keep tracking release tags. To switch one to
`main`, remove the plugin and install it again from the source above. Removal
clears plugin settings, secrets and schedules.

Optional CLI route: in the bb thread's right panel, choose **Open new tab →
Start terminal**. bb provides
its CLI there; your system Terminal does not need a `bb` command:

```sh
bb plugin outdated
bb plugin update zcode-provider --yes
bb plugin remove zcode-provider
```

Plugin-local data can remain after removal.
[Manual cleanup instructions for v0.2.4](https://github.com/emlevsky777/bb-plugin-zcode/blob/v0.2.4/README.md#L109-L135).

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
  Image interpretation depends on the native model. Some models use ZCode's
  image analysis tool to read an accepted attachment.
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

The standard bb context indicator shows estimated context use and the selected
model's capacity. It updates when ZCode reports accounting data. Cold
continuation restores the native reading. After compaction, the indicator
waits for accounting from the next main request.

BB plugin tools are available to ZCode through a local MCP endpoint for the
session. If the plugin cannot interpret the MCP configuration, it retains
native configuration and explains why BB plugin tools are unavailable.
Cold continuation rebuilds the endpoint. Steering retains the active tool
catalogue. Stop or disconnect cancels pending BB calls without retry.

The endpoint listens on `127.0.0.1` without a token. Other local processes
can invoke tools in the thread's context. Requests carrying `Origin` are
refused. Native subagent forwarding of BB tools and image perception through
those tools remain unverified.

MCP configuration is loaded at session creation. After adding a server in
Desktop, use a new bb thread or stop and cold-continue the existing thread.
Complete the first MCP OAuth sign-in in Desktop; initiating it inside bb is
not established. An individual server's startup failure remains in diagnostics
and `bb zcode-provider-report`, without a conversation warning or blocking ordinary
input. Configured hooks follow ZCode's enablement and trust rules. Live hook
behavior remains unverified. Tool exclusions apply to whole tools.

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
Check eligibility and claim in ZCode Desktop, then refresh the bb model list.
Discovery may take up to one minute. An offer is separate from a granted
balance. The plugin leaves claiming to Desktop.

Start models leave the catalogue at its next successful refresh after access
expires or a fresh balance confirms no available tokens. bb can retain a stale
catalogue on refresh failure, and its composer can select the default available
model when the old one disappears: check the model before sending after a
promotion ends. The plugin rejects a directly requested unavailable Start ID
and never substitutes a Coding model. Earlier revocation can first be detected
by server rejection. After activation, bb may first return its stored model
list while refreshing it in the background; reopen the picker once if needed.

## Compatibility

v0.2.4 was verified on Apple silicon with **bb 0.50.1 and ZCode Desktop 4.0.0
(CLI 0.18.0)**. The check covered Desktop sign-in, a GLM-5.4 turn with file
and terminal tools, a call to a BB plugin tool, and continuation of the same
session in a new process.

v0.2.4 can still show its compatibility notice on this tested setup.

Windows, Linux, Intel macOS, Team Coding Plan, off-peak plans, BigModel and
Browser Use are unsupported. Computer Use and server-side quota accounting
for the backup key remain unverified. Individual tiers other than Lite are
still awaiting verification.

[Release history](RELEASE_NOTES.md) · [Earlier compatibility results and offline checks](compat/README.md).

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
