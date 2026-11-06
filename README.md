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

Three related dead ends get a hint in the failed result:

- **find timeout**: when `find` times out before its judge verified a hit, the
  extension runs an 8-second literal search (`rg`, or `grep` where `rg` is not
  installed) for the query's words in the same scope. It lists the files with
  the most matches, or the matching lines when the scope is one file. A search
  that is killed or errors adds nothing.
- **GitHub owner typo**: when a `bash` command that names `joshuawarren/<repo>`
  on GitHub gets a 404, the result names the real owner `joshuaswarren/<repo>`.
  The `Joshuawarren` account belongs to someone else, so the 404 is the typo,
  not an outage.
- **home directory typo**: when a `bash` command fails and an unquoted path in
  it, or its `cwd`, names a home directory one or two letters away from the
  real one (`/home/jososhuawarren` for `/home/joshuawarren`) that does not
  exist, the result names the real home. The command is never rewritten: a
  corrected write target could change a file the command did not reach.
  Quoted text, heredoc bodies and comments are data (for example a note that
  quotes the typo), and `ssh`, `scp`, `rsync` and `sftp` commands name another
  machine's paths, so they get no hint.

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

## Do not combine with a path-confinement guard

omp gives every other extension's `tool_call` handler the input that the model
wrote, not the input that this extension rewrote. A guard that confines paths
(for example "only inside this checkout") therefore checks the old path, while
the tool reads the new one. Do not load path-guard in a session that relies on
such a guard.

## Develop

```sh
bun install
bun run lint
bun run typecheck
bun test
```

## License

MIT
