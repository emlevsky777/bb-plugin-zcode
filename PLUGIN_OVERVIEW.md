Run your installed ZCode coding agent inside bb with an individual Z.ai Coding
Plan. Use its account models, reasoning levels, file/terminal tools, native
skills and commands. Supports continuation, background work, stopping, context
compaction, guidance during a turn, and subagents when enabled in bb.

Requires macOS on Apple silicon, bb 0.45.0 or newer, installed ZCode Desktop,
Git and a ZCode Coding Plan login. Checked with bb 0.45.0, SDK 0.6.15,
ZCode Desktop 3.14.4 / CLI 0.16.9 and Lite. Later combinations need verification.
Browser Use is unsupported on the checked combination; Computer Use is not
established. User MCP and direct project hooks are not connected.

An unofficial early plugin, unaffiliated with Z.ai, ZCode or bb. ZCode sends
model requests; compliance with Coding Plan terms is your responsibility.
Plugins run as full-trust code. Read the trust boundaries and limits first.
The repository is currently private and requires access.

```sh
bb plugin install 'git:https://github.com/emlevsky777/bb-plugin-zcode.git@v0.1.0-rc.1' --yes
```

Run `bb zcode-report` for a local report; it uploads nothing.
Report issues with reviewed output and reproduction steps, excluding secrets:
https://github.com/emlevsky777/bb-plugin-zcode/issues

Apache-2.0. Full instructions: https://github.com/emlevsky777/bb-plugin-zcode
