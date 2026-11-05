# ZCode Provider v0.2.1

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
