# ZCode for bb

Run your installed ZCode coding agent inside [bb](https://getbb.app) with an
individual Z.ai Coding Plan: files, terminal tools, native skills and commands.
[Russian edition](README.ru.md).

This early unofficial plugin is unaffiliated with Z.ai, ZCode or bb. The plugin
does not call Z.ai directly: your installed ZCode sends requests. You are
responsible for complying with your Coding Plan terms. The repository is
currently private; installation requires repository access.

## Requirements and installation

Requires macOS on Apple silicon, bb 0.45.0 or newer, installed ZCode Desktop,
Git and an individual Coding Plan login (Lite checked). bb supplies Node and
build tools; Python, Homebrew and global npm are unnecessary.

In bb, open **Settings → Installed plugins** (Plugins), then **New plugin
options → Install from source**, and paste:

```text
https://github.com/emlevsky777/bb-plugin-zcode.git
```

Review and confirm. This URL tracks the default branch, currently `main`;
it does not pin the `v0.1.0-rc.1` tag.

bb builds both server and host bundles. Plugin ID: `zcode`. Open a thread, select
**ZCode**, a model (GLM-5.3 when available), permissions **Full**, and send a
message. bb permissions govern tool access; review commands and project trust.

If sign-in is needed, copy the complete Terminal command from provider status
and finish ZCode's login flow. `zcode` need not be on PATH. The next request
detects login changes without restarting bb. Spotlight locates renamed bundles;
fallback search uses `/Applications` and `~/Applications`. System Applications
is preferred when multiple copies exist.

Stop every ZCode thread with its **Stop** button before updating or removing.
Open **Settings → Installed plugins → ZCode** to review and apply an offered
update. To remove it, choose **ZCode actions → Remove from bb**. Updates follow
the recorded source; tags and commits are pinned and require removal and fresh
installation to change source. Removal clears settings, secrets and schedules,
while bb 0.45.0 retains files and session data.

Optional CLI route: in the bb thread's right panel, choose **Open new tab →
Start terminal**. bb provides
its CLI there; your system Terminal does not need a `bb` command:

```sh
bb plugin outdated
bb plugin update zcode --yes
bb plugin remove zcode
```

Removal unregisters the plugin and deletes its settings, secrets and schedules.
bb 0.45.0 retains Git checkouts and plugin data for Git plugins. With the default
bb data directory, these are:

- `~/.bb/plugins/cache/git/github.com/emlevsky777/bb-plugin-zcode/<commit>/`
  — the checkout and built bundles for the installed commit.
- `~/.bb/plugins/zcode/` — plugin data, including `host-data/` and `bridge-data/`.
- `~/.bb/plugin-host-artifacts/zcode/` — downloaded host bundles.

For optional complete disk cleanup, copy the exact **Source** path from plugin
details **before** removal. In bb's terminal, `bb status --json` reports `dataDir`;
if it differs from `~/.bb`, use that directory in the paths below. Stop every
ZCode thread, including background work, then choose **Remove from bb**.
Only after that, remove the exact retained directories manually:

```sh
# Replace <commit> with the checkout ID recorded before removal.
rm -r -- "$HOME/.bb/plugins/cache/git/github.com/emlevsky777/bb-plugin-zcode/<commit>"
rm -r -- "$HOME/.bb/plugins/zcode"
rm -r -- "$HOME/.bb/plugin-host-artifacts/zcode"
```

Remove a checkout only when no other installed plugin uses it; do not delete the
whole bb Git cache. Manual data removal discards plugin-local session data and
caches, so those native sessions can no longer be resumed. Neither plugin removal
nor this cleanup touches your ZCode Desktop login/history or bb thread history.
Save needed settings first; never put secret values in a chat or issue.

## Capabilities and limits

- Account model catalogue and supported reasoning levels. Missing explicitly
  selected models or efforts fail without substitution.
- Continuation, foreground/background stop, context compaction, guidance during
  an active turn, and subagents with bb's setting enabled.
- Native skills selected with `/` or `$`, and native commands with `/`: one
  command per message. New resident skills may require a new thread; bb's menu
  cache may take about ten seconds to refresh.
- PNG/JPEG/GIF/WebP images up to 10 MiB, inline image data, and UTF-8 files up to
  256 KiB. PDF, binary files and remote image URLs are rejected.
- Personal/project instructions and standalone skills. Optional native plugins
  require explicit enablement. User MCP and direct project hooks are not
  connected; official capabilities depend on ZCode and bb support.

Guidance queued by ZCode can be lost on disconnect/resume and is not replayed.
It retains the active turn's model, reasoning and login mode; changed options
apply to the next ordinary turn. Uncertain submissions are not automatically
resent. Check the thread before retrying. Service failures show reason/code;
inspect bb's pending retry before sending again.

An optional **Backup Coding Plan key** belongs only in the protected plugin
setting. Explicitly select `coding-plan-key`; there is no automatic switch from
CLI login or to pay-as-you-go API. Stop all work before changing modes.
Server-side quota accounting for key mode has not been established.

## Compatibility

Statuses describe observations, not guarantees for later versions.

| Configuration or capability | Status |
| --- | --- |
| macOS arm64; bb 0.45.0, SDK 0.6.15, host Node 24.20.0; ZCode Desktop 3.14.4 / CLI 0.16.9; individual Lite | Checked |
| Later bb/ZCode versions; individual plans other than Lite | Pending verification |
| Windows, Linux, Intel macOS; Start Plan, Team Coding Plan, off-peak, BigModel | Unsupported |
| Browser Use on the checked combination | Unsupported: native interaction rejected |
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

Shared ZCode login is read without changes. bb sessions keep separate data/history
and do not appear in Desktop. The plugin writes session bindings, native data,
isolated configuration views, caches and diagnostics under its bb data directory.
Original personal/project settings and skills are read in place. Optional native
plugins may run hooks in both Desktop and bb; enabling them expands the code you
trust. Post-startup isolation checks cannot undo earlier startup effects.

The diagnostic observer is inactive without explicit configuration of an owned
loopback proxy and certificate. Local reports exclude prompts, workspace content
and credential values. Diagnostic journals rotate, but native history and host
caches have no hard total size cap. Never publish the data directory, raw native
logs, credentials or authorization links.

## Reporting a problem

In a bb thread's right panel, choose **Open new tab → Start terminal** and run
`bb zcode-report`.
bb supplies the CLI in this terminal; no system PATH setup is needed.
Attach its reviewed output to a
[GitHub issue](https://github.com/emlevsky777/bb-plugin-zcode/issues), with steps,
time/timezone and exact error. It uploads nothing. With multiple installations,
use `bb plugin run zcode` explicitly. Server logs: `bb plugin logs zcode`.

## Development and license

On supported host Node: `npm ci`, `npm run typecheck`, `npm test`.
`bb plugin build` produces server and host artifacts. Tests are offline with
synthetic fixtures and do not spend Coding Plan quota.

[Apache-2.0](LICENSE). Adaptations are attributed in [NOTICE](NOTICE) and
[the upstream license](LICENSES/Apache-2.0.txt).
