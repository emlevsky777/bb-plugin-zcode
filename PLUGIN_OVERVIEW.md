Run installed ZCode inside bb with an individual Z.ai Coding Plan. Includes
account models, reasoning levels, file/terminal tools, native skills and commands,
continuation, background work, stop, compaction and guidance during a turn.

Requires Apple silicon macOS, bb 0.47.1+, installed ZCode Desktop and Git
(Xcode Command Line Tools). bb supplies host Node and build tools; global npm,
Python and Homebrew are unnecessary. Checked: bb 0.47.1 / SDK 0.6.79 / host Node
24.22.0 / Desktop 3.15.1 / CLI 0.16.9, individual Lite plan. Other combinations
need verification. Windows, Linux, Intel macOS and Browser Use are unsupported;
Computer Use is not established.

Unofficial early plugin, unaffiliated with Z.ai, ZCode or bb. The repository is
currently private; installation requires repository access. No stable release
is promised by the default branch.

In Settings → Installed plugins → New plugin options → Install from source,
paste `https://github.com/emlevsky777/bb-plugin-zcode.git` and confirm. This
tracks main. Complete Z.ai sign-in in ZCode Desktop, select ZCode in a new thread
and use Full permissions. The real HOME and Desktop store are shared; bb keeps
separate sessions/history/logs. Native ZCode may refresh shared tokens; the
plugin does not write Desktop settings or CLI config. Rejected sign-in requires
signing in again in Desktop; merely opening it is not a verified token refresh.

Stop all ZCode threads and background work before updating or removing. Open
Settings → Installed plugins → ZCode for an offered update, or choose ZCode
actions → Remove from bb. Updates track the recorded source; pinned tags and
commits require fresh installation to change source. Removal clears settings,
secrets and schedules; exact retained data cleanup is described in the README.

In a thread's right panel choose Open new tab → Start terminal, then run
`bb zcode-report --help`, `bb zcode-report` or `bb zcode-report --json`.
The terminal supplies bb without a system CLI installation. Reports are
server-local, exclude secrets/session contents/personal paths and upload nothing.
They do not diagnose remote agent hosts or prove sign-in readiness.

Native MCP uses existing Desktop configuration; first MCP OAuth sign-in is in
Desktop. Hooks follow native enablement/trust; configured-hook behavior is not
live-proven. After automatic compaction the rest of that turn can lack the full
bb instruction/skill block; the next ordinary turn restores it. Automatic guide
reinjection is not enabled. New instruction/skill metadata needs a new session.

Plugins and native tools have full trust and account access. ZCode sends model
requests; review trust boundaries and Coding Plan terms before use. Never share
raw logs or credentials. Apache-2.0.

[Installation, update, removal and limits](https://github.com/emlevsky777/bb-plugin-zcode#readme)

[Report an issue with reviewed output](https://github.com/emlevsky777/bb-plugin-zcode/issues)
