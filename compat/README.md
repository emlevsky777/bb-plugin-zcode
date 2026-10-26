# Release compatibility inspection

25 October 2026: the current-base review covers all 72 previous entries and
the new OAuth/project-token dependency (73 total), including all 15 weak anchors.
[Artifact identities](M4.9.8c.1b-artifacts.json)
include the changed native engine and builtin config. This source/offline review
alone does not establish level1. On 26 October 2026 the owner accepted audit 2,
the final live series and the blank-page Notion read; the exact combination is
now registered as level1. See the compatibility table in [README](../README.md).

Run from the repository with the host Node supported by bb:

```sh
node scripts/provider/compat-level0.mjs
node scripts/provider/compat-level0.mjs --bb /path/bb.app --zcode /path/ZCode.app --registry compat/touchpoints.json
```

The defaults are `/Applications/bb.app` and `/Applications/ZCode.app`.
The tool reads physical bundle files and packed/unpacked ASAR entries. It does
not start an app, CLI, login, model or network request. JSON stdout reports each
anchor, affected source files and the function's failure consequence. Exit codes:
0 means all strong anchors were found; 1 means a strong anchor is missing;
2 means invalid input. A missing file is a missing anchor, with a diagnostic.
Weak anchors always appear in `affected`, even when their text is present.

`touchpoints.schema.json` describes the JSON structure. `validateRegistry` in
the tool enforces that structure plus unique IDs/dependencies, relative paths
without traversal, milestone syntax and nonempty descriptions/provenance.
All anchors of a point are required. SDK anchors use bb's shipped artifacts,
not the repository's pinned npm package. Bundled-away export names are replaced
with observable schema keys; generic/indirect evidence is marked weak.
Paths in `code` name product or development files, not upstream symbol offsets.

Presence of text is a review signal, not proof of behavior or safety. In
particular, sync/async filesystem changes can preserve the same strings. Review
the affected mechanism and run the existing offline and live checks before
claiming a new version combination. The tool neither updates checked tuples
nor enables/disables product features. It is the offline level-0 building block
for the later VPS pipeline, without scheduling, downloading or notifications.

The public export retains artifact identities and the complete dependency
registry. Its provenance links point to this public summary; private execution
reports and raw observations are not distributed. Development-only code paths
omitted from the package point here when no product path remains. The checked
runtime tuple is unchanged; its public references use the README compatibility
table and the artifact identity JSON.

## Provenance and consolidation

The 2026-10-10 registry merges repeated surfaces into one point with multiple
milestones and sources. Historical tables remain unchanged. The M4.2 list in
`docs/KNOWLEDGE.md` covers transport/rows/status, auth/config/interactions,
background/continuation, SDK/host/artifacts and host lifecycle; all groups are
represented. M1 through M4.4.2 were collected once from implementation reports
012 and 014–021 and the current product paths. Removed historical modules are
mapped to their current equivalents (`native.ts`, `translator.ts`, `runtime.ts`).

| Historical source | Registry groups covering its dependencies |
|---|---|
| M1 / M2 | zcode-v4, framing, rows, hydration, env, builtin, config-env, runtime-headers, credentials, credential-cipher, interactions, mcp-ready; sdk-bridge, delta; bb-artifact, shutdown, host-node, persistent-data |
| M3 / M4.1 | zcode-background, hydration, rows; sdk-delta, bb-shutdown, plugin-checkpoints |
| M4.2 / KNOWLEDGE | All transport/auth/continuation/SDK/lifecycle groups above; bb-version, sdk-version; zcode-desktop-version |
| M4.3 | zcode-credentials, credential-cipher, builtin, runtime-headers, login, unsupported-plans; bb-secrets, sdk-health |
| M4.4 / M4.4.1 | zcode-helper, layout, personal-config, catalogue, model-bootstrap; sdk-roots-schema |
| M4.4.2 / M4.5 | sdk-mentions, zcode-attachment, mcp-ready |
| M4.6 / M4.6.1 | zcode-personal-config, catalogue, env; sdk-host, roots-schema, warning; bb-roots-cache, settings |
| M4.6.2 | zcode-plugin-discovery, registry, project-view, env, hydration; sdk-roots-schema; bb-settings |
| M4.6.3 | zcode-env, plugin-registry, official-manifest, plugin-discovery, project-view, plugin-guard, trust; sdk-host |
| M4.6.4 and continuation | sdk-steer, zcode-steer, official-manifest, plugin-guard, rows, attachment, hydration |
| M4.7 | sdk-mentions, steer, roots-schema; zcode-catalogue, resident-skills, skill-tool, custom-command, steer |
| M4.7.1 | sdk-compact, warning, mentions, steer; zcode-compact |
| M4.8 | bb-subagents-setting, sdk-delegation; zcode-subagents, child-model, runtime-headers, background; existing mentions/steer/compact points |
| M4.9.1 | bb-version, sdk-version, artifact; sdk-bridge, delta, host |
| M4.9.2 | zcode-service-error, error-codes, business-errors, rows; sdk-health; bb-retry |
| M4.9.3 | zcode-desktop-version, layout, helper, credentials, login, unsupported-plans; bb-version; sdk-health |
| M4.9.4 | zcode-desktop-version, layout, helper; bb-persistent-data, version, sdk-version, settings; sdk-health, warning; plugin-checkpoints |
| M4.9.5 | zcode-production, observer, hydration, cua; bb-settings, persistent-data, version; plugin-checkpoints |
| M4.9.6a / M4.9.6b | zcode-catalogue, resident-skills, desktop-version, layout; sdk-reasoning; bb-secrets, roots-cache; three interception groups and plugin-checkpoints |

M4.9.2's response injector depends on mitmproxy only inside the development
stand. It is not a bb/SDK/ZCode release dependency; it is covered by the existing
stand tooling checks. Other plugin-owned records (binding, translator and
background versions, application-path and data-maintenance notices) depend on
host data lifetime, not an upstream schema; `plugin-checkpoints` explicitly
uses a weak indirect anchor, and the same-thread update smoke checks behavior.
