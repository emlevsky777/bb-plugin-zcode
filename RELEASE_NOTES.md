# Unreleased — public main

New ZCode Provider threads can show one notice before the first model answer.
It combines a warning about BB or ZCode Desktop releases newer than the tested
versions with an available provider update reported by BB. Follow-up prompts
and resumed threads do not repeat it. Missing notice information leaves the
ordinary startup and authentication paths available.

Update information is read only when a new thread needs it, sharing one saved
result across this installation's hosts for an hour. There are no idle reads
or separate upstream checks. Installing a new plugin copy clears an obsolete
offer even when the package version stays the same, while a reload of the
same copy reuses the saved result.

Verification: 400 source tests and 27 focused built-artifact tests passed on
BB's Node 24.22.2. Four earlier real GLM-5.4 turns confirmed visible notice
ordering, silence on follow-up and cold resume, and normal input with
unavailable notice metadata. Version/update notice inputs were synthetic;
installation changes and overlapping host starts were checked locally.
This is a main-branch update, not a new tagged release. The latest release
remains v0.2.4; installations tracking release tags do not receive these
changes until a later release.

# ZCode Provider v0.2.4

## Desktop model catalogue and bb compatibility

Read the newer Desktop model catalogue from its shared endpoint/platform/product
version path, rather than relying only on the packaged release. This exposes
GLM-5.4 when the native account catalogue offers it. Desktop retains ownership
of catalogue refresh; no configuration copies or account changes are needed.
The working native process validates its selected catalogue; absent, older or
invalid active data uses the packaged catalogue without repairing shared files.
A temporary active startup failure does not persist a fallback model list. The
model cache follows both inputs; the CLI does not select a second dev catalogue.
A rejected first working-model check leaves the same BB thread available for
ordinary start after the catalogue recovers, including after a service restart.
An unknown native create outcome still requires reconciliation before retry.

Read current Desktop v2 credentials through ZCode's installed native keyring
module. The earlier reader could send an unrecognized encrypted envelope as
a token and receive an authorization failure. Credentials remain in the shared
Desktop store; macOS can request access to the encryption key for a bb process.
OAuth uses the active profile without depending on legacy identity. Secret
source/mode selection follows Desktop; a shared key failure stops one catalogue
operation. Cold project-token issuance has the native bounded transient retry,
with account-scope checks and no repeat of a user input.

This patch includes the previously accepted BB tool bridge and native context
indicator described in the README. Fork and message editing remain disabled.
The npm SDK dependency remains 0.6.79. Source-backed tests and moved compatibility
anchors now cover bb 0.50.1 and ZCode Desktop 4.0.0 / CLI 0.18.0.

## Verification status

On macOS arm64 with bb host Node 24.22.2 and installed SDK 0.6.157, the source
suite includes distinguishing OAuth, native catalogue, secret-source and issuance-retry checks. Native and BB catalogues expose GLM-5.4 with low/high/max
reasoning. A Desktop-sign-in GLM-5.4/high/Full task completed file/terminal work
and a native HTTP call to a BB plugin tool with the actual SDK thread, project
and environment context. Native retries recovered from service rate limits.
Cold continuation restored the same native session in a new process, retained
the prior result and completed another actual BB tool call. v0.2.4 was
[published on 23 November 2026](https://github.com/emlevsky777/bb-plugin-zcode/releases/tag/v0.2.4).
Existing limits for automatic compaction, instruction retention, Usage and
actual expiry remain in place. The release carried forward the existing
Level 1 records.

# ZCode Provider v0.2.3

## bb thread context in native tools

Explicit environment supplied by bb is now applied after inherited-process
cleanup. Native terminal tools retain the project/environment IDs, thread
storage and bb CLI connection metadata. Previously `bb status` could identify
the thread while returning no project. Canonical thread identity, real HOME,
shared Desktop sign-in and native session/log paths are retained.

The bb 0.49.0 installed-source retry fixture now follows its continuation
argument, and the compatibility checker locates the moved renderer anchor.
No dependency or SDK pin changes are required.

## Verified scope and update

macOS arm64, bb 0.49.0 / installed SDK 0.6.132 / host Node 24.22.2,
ZCode Desktop 3.17.2 / CLI 0.17.1: Desktop-sign-in Coding Flash/high/Full
file/terminal work, correct bb CLI project/thread context and cold continuation.
This is a limited representative check, not a new Level 1 tuple. Existing
automatic-compaction/instruction-retention, Usage and actual-expiry limits
remain; the unchecked-combination notice is retained.

The existing `git:https://github.com/emlevsky777/bb-plugin-zcode.git@^0.2.0`
source accepts v0.2.3 through normal `bb plugin update zcode-provider`.
Identity, settings, dependency resolutions and shared history layout are
unchanged. No reinstall, source switch or migration is required.

# ZCode Provider v0.2.2

## Start Plan models and independent Usage

Entitled Start models now appear alongside Coding Plan models with distinct
IDs, such as `start-plan/GLM-5.3-Flash`. Select the plan through each thread's
model picker. Start uses the existing shared ZCode Desktop sign-in; Coding Plan
key mode remains Coding-only. A requested unavailable Start ID is rejected
without substituting Coding. bb can retain its last catalogue during refresh;
after activation, reopen the picker once if the new model has not appeared yet.

Both native Provider Usage views show Coding quota percentages/reset times and
Start token remaining/total with access expiry independently. Claimed future
grants show pending activation without early model access. A claimed plan with
no reported balance stays labelled as claimed, rather than as an absent
promotion. Catalogue and Usage demand share scoped snapshots, normally for one
minute; manual refresh may reuse them. Errors and the other plan remain separate.

Optional **Check for Start Plan promotions** is off by default. When enabled,
selected Desktop claim offers can produce qualified new-thread guidance.
Claim remains an owner action in Desktop; the plugin never claims, reports
marketing actions or downloads campaign assets. Claimed quota works with this
setting off. Server impression/frequency-cap effects remain unknown.

With memory enabled, eligible completed turns also run native project-memory
extraction against the Start quota, as in Desktop. Desktop's memory setting
takes priority over the plugin fallback; the plugin adds no extraction loop.

## Verified scope and update

On macOS arm64, bb 0.48.1 / installed SDK 0.6.104 / host Node 24.22.0,
ZCode Desktop 3.17.2 / CLI 0.17.1, a real Flash promotion was observed pending
before its effective start and active afterwards. A Flash/high/Full turn
completed through the Start gateway and a later balance reported a debit.
Native retry and memory requests are included in the series; exact per-request
billing and absence of Coding charges from rounded percentages are not proven.
The final memory request occurred after the last measured balance.

Post-start access with no reported balance bucket and a warm-session transition
through actual expiry remain unproven. Compact Usage rounds small percentages
to whole numbers; its token label retains exact remaining units. Existing
automatic-compaction/instruction-retention limits and the unchecked-combination
notice remain. No new level1 compatibility tuple is registered.

The existing `git:https://github.com/emlevsky777/bb-plugin-zcode.git@^0.2.0`
source accepts v0.2.2 through ordinary `bb plugin update zcode-provider`.
Plugin identity, short description, settings, history, dependency resolutions
and SDK pin are unchanged. No source switch or migration is required.

# ZCode Provider v0.2.1 (previous release)

## Desktop 3.17.2 history correction

Active-history reconciliation now follows reviewed native
`compactLeadingMessageIds`: retain explicitly named messages before the latest
compact boundary, preserve their original order, and exclude every boundary's
leading IDs from the optional preserved segment. Assistant usage resets follow
native hydration. This avoids scheduling another frozen bb prefix when the
complete block is already retained in that active history. It does not change
the native compactor or add automatic guide reinjection.

The ordinary real-user message carrying the initial bb block does not qualify
for native leading reminders. In the representative manual-compact session it
was removed, and the next ordinary model request contained exactly one restored
full block. A changed everyday delivery outcome and live occurrence of leading
IDs are not claimed. Native-function comparisons cover both verified 3.16.3 and
installed 3.17.2 sources, including overlap, invalid IDs and cold state reload.

Memory/OAuth inspection anchors include the verified 3.17.2 host chunks; old
strong anchors and OR locations remain. Endpoint-specific Desktop OAuth and
real HOME/shared-store behavior are retained. No dependency upgrade: declared
SDK 0.6.79, plugin-owned zod 4.6.6 and every lock resolution stay unchanged.

## Observed scope

macOS arm64, bb **0.48.1**, installed SDK **0.6.104**, host Node **24.22.0**,
Desktop **3.17.2**, CLI **0.17.1**: Flash/high/Full Desktop-login file/terminal
task, cold resume, successful manual compact and the next ordinary request.
This limited series was accepted on 5 November 2026. It does not register a new
level1 tuple or rerun attachments, questions, Stop-during-work, native subagents
or external integrations. The existing unchecked-combination notice remains.
Older accepted tuples below retain their dated evidence; the old 3.16.3 native
functions were rerun offline on final code, not in an old Desktop process.

Successful automatic compaction and live leading-specific coverage remain
`not_proven`. The remainder of an automatically compacted turn can lack the full
bb instruction/skill block; its next ordinary turn checks restoration. Broader
platform/plan support, real token expiry and full HTTP/billing accounting remain
outside the verified scope. The current `^0.2.0` source range accepts this patch
through the existing update path; no identity transition or state migration is added.

The offline npm-test runner now places its default synthetic fixtures in an
owned temporary directory and removes it after the run. Explicit fixture-root
overrides, inherited environment, test selection and exit outcomes are retained.

# ZCode Provider v0.2.0 (previous release)

## Distinct identity and fresh installation

The product is now **ZCode Provider**, package `bb-plugin-zcode-provider`,
plugin and provider ID `zcode-provider`. The public repository stays
`emlevsky777/bb-plugin-zcode`. The diagnostic command is
`bb zcode-provider-report`; no old command or provider aliases are registered.
This separates this plugin from other authors' ZCode plugins.

Install afresh from
`git:https://github.com/emlevsky777/bb-plugin-zcode.git@^0.2.0`, then select
**ZCode Provider** in a new thread. Our existing `^0.1.0` installations stay
on the v0.1.x line; `bb plugin update zcode` does not perform this transition.
After verifying the new installation, disable our old `zcode` installation
through Settings. Retain its data and archived history as needed. Settings,
secrets, sessions and history are not copied or migrated. Old threads are
unsupported by the new provider; start new sessions.

Fresh defaults: Desktop sign-in, memory fallback ON, native provider subagents
enabled, no backup Coding Plan key. Desktop memory preference takes priority.
The real HOME and shared Desktop sign-in/store remain native and unchanged.

## Retained native behavior

The retained v0.1.1 OAuth adaptation matches ZCode Desktop 3.16.3. The customer-info request
uses the native endpoint-specific Authorization format; key/access-token
requests retain Bearer. Server rejection of v0.1.0's older header has not
been proven.

## Compatibility and corrections

- Verified on macOS arm64: **bb 0.48.0 / ZCode Desktop 3.16.3**, installed
  SDK 0.6.94, host Node 24.22.0 and CLI 0.17.0. Checked paths include shared
  Desktop OAuth, representative models, cold resume, memory and active
  guidance, manual compaction, local-file attachments, native questions,
  Stop and an ordinary turn after Stop.
- Retains the accepted **bb 0.47.1 / Desktop 3.15.1** combination with
  SDK 0.6.79, host Node 24.22.0 and CLI 0.16.9.
- Updates native memory/OAuth source anchors for the observed Desktop
  layouts and compatibility diagnostics for the new verified tuple.
- Plugin-owned zod is 4.6.6, including host and SDK-subpath bundles;
  the declared SDK stays 0.6.79. Other dependency resolutions are retained
  from the accepted compatibility candidate.

## Limits

The native-runtime observations above are retained from accepted v0.1.x
verification. This identity release does not remeasure the full matrix or
add platform/plan support.

Successful automatic compaction remains **not_proven**. An internal native
request and the remainder of an automatically compacted turn may lack the
full bb instruction/skill block; the next ordinary turn checks restoration.
Stop during compaction was not separately verified. No replacement native
compaction or synthetic context-fill retest was added.

bb-owned zod 4.6.5 remains an external limitation; this patch fixes the
plugin-owned copy and does not fix bb's separate copies. Other
[README compatibility and feature limits](README.md#compatibility) remain,
including unverified background lifecycle, native menu selections, real token
expiry, and full HTTP/billing accounting. No new platform or plan support
is claimed.
