# omp-path-guard

An [omp (oh-my-pi)](https://github.com/can1357/oh-my-pi) extension for one
common agent failure: a tool call names a path that does not exist.

The built-in `read`, `grep`, `glob`, `find`, and `edit` tools answer "not
found" and nothing more. The model then guesses again, often more than once.
Typical causes are a file that moved to another repository, a path written
relative to the wrong checkout, a misspelled directory, a wrong file name, or
an edit header that holds only the file name.

## What it does

Before the call runs, the extension rewrites the path only when the real path
is provable:

- **edit**: the hashline header `[path#TAG]` names a snapshot tag that this
  session already saw in a `read` or `grep` result, and that file has the same
  name. The edit tool still checks the tag, so a wrong file cannot be edited.
- **read, grep, glob, find**: the same repository-relative path (with at least
  one directory) exists under a root the session already used, under the
  current repository, or under a configured companion checkout. A path that
  names one worktree is not moved to a sibling worktree of the same
  repository.
- **typo**: one misspelled directory name is the only way the rest of the path
  exists.

The tool result then starts with one line that names the path it used.

When no path is provable, the extension adds the closest real paths to the
not-found error: the same tail in other roots and worktrees, the neighbours of
the missing name, and tracked files with the same name. It does the same for a
`bash` command that fails to open a script (`can't open file`,
`Could not open input file`, `No such file or directory`).

Every handler fails open. An internal error never blocks or changes a call.

## Install

Copy the file into the omp extensions directory:

```sh
curl -fsSL https://raw.githubusercontent.com/joshuaswarren/omp-path-guard/main/path-guard.ts \
  -o ~/.omp/agent/extensions/path-guard.ts
```

New omp sessions load it. To try it in one session only, run
`omp -e ./path-guard.ts`.

## Configure (optional)

When one project spans two repositories, list the companion checkouts in
`~/.omp/agent/path-guard.json`. The extension tries them after the roots that
the session already used:

```json
{ "roots": ["~/src/project-code", "~/src/project-docs"] }
```

## Develop

```sh
bun install
bun run lint
bun run typecheck
bun test
```

## License

MIT
