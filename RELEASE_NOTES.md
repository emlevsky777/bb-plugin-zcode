# ZCode for bb v0.1.1

Updating to **v0.1.1 is recommended for ZCode Desktop 3.16.3 users** because
its OAuth semantics match that Desktop release. The customer-info request
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

## Installation and limits

Install from source using
`git:https://github.com/emlevsky777/bb-plugin-zcode.git@^0.1.0`.
Existing range-based installations can use `bb plugin update zcode` after
this release is published. Exact tag/commit pins do not follow range updates.

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
