# Tyr documentation

User-facing documentation for Tyr, written for [Mintlify](https://mintlify.com).
`docs.json` holds the site configuration and navigation; every page is an
`.mdx` file whose path (without the extension) is listed there.

## Preview locally

```bash
npm i -g mint      # Mintlify CLI
cd docs
mint dev           # http://localhost:3000
```

`mint broken-links` checks internal links.

## Layout

| Folder | Contents |
| --- | --- |
| `getting-started/` | Introduction, quickstart, installation, core concepts |
| `guides/` | Task-oriented pages: Claude Code, watching, checks, review, reports, team setup |
| `configuration/` | Settings, `tyr.json`, ignore patterns, environment variables |
| `cli/` | One page per command |
| `reference/` | `.tyr/` layout, event kinds, diff-review rules, supported tools, troubleshooting |

## Writing conventions

- Lead with what the reader gets, then how. Short sentences, second person.
- Every command, flag, default and file path must match the code. When behavior
  changes, update the page in the same commit.
- Features that are not built yet are marked with a `<Note>` saying so; never
  document planned behavior as if it works.
- MDX treats `{`, `}` and `<` as syntax: keep JSON, placeholders like
  `<prompt>` and shell snippets inside backticks or code blocks.
