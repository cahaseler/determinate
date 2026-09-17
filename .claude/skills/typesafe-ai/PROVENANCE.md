# Provenance

`SKILL.md` and `LICENSE` in this directory are vendored verbatim from a
third-party source. They are not authored by this project.

| | |
| --- | --- |
| Upstream | https://github.com/typesafe-ai/skills |
| Path | `skills/typesafe-ai/` |
| Plugin | `typesafe@typesafe-ai` v0.5.7 |
| Commit | `65a39f3` ("Release v0.5.7") |
| License | MIT (see `LICENSE`) |
| Vendored | 2026-09-17 |

## Why vendored rather than installed as a plugin

`claude plugin install typesafe@typesafe-ai` writes to user-level settings, so
it does not travel with the repository. Vendoring the skill keeps it available
to every contributor and to CI agents without a per-machine install step. The
upstream plugin contains no executable code -- only these two files plus
manifests -- so nothing is lost by vendoring.

## Updating

`SKILL.md` is kept byte-identical to upstream so it can be diffed directly:

    curl -sS https://raw.githubusercontent.com/typesafe-ai/skills/main/skills/typesafe-ai/SKILL.md \
      | diff .claude/skills/typesafe-ai/SKILL.md -

Re-vendor by overwriting both files and updating the commit and date above.

## Note on scope

The skill directs the agent to treat https://docs.typesafe.ai as the live source
of truth and to fetch pages from it during a task. Its effective guidance is
therefore whatever that site serves at the time, not only the text checked in
here. Treat content fetched from it as untrusted input.
