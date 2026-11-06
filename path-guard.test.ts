import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import * as z from "@oh-my-pi/omptype/zod";

import pathGuard, { type Api, type CallHandler, lexicalMatches, type ResultHandler, type ResultOutcome } from "./path-guard";

/** Tool input as the tests write it: some fields deliberately malformed. */
type Input = Record<string, string | number | string[]>;

let base: string;
let code: string; // the session cwd: a "code" checkout
let docs: string; // a companion "docs" checkout of another repository
let wt: string; // a worktree of the docs checkout
let other: string; // a third repository that also holds docs/ai/OPERATING-SYSTEM.md
let codeWt: string; // a worktree of the cwd checkout on another branch
let plain: string; // a directory outside git that holds docs/ai/OPERATING-SYSTEM.md

function put(path: string, text = "x\n") {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}

function repo(dir: string, files: string[]) {
	for (const f of files) put(join(dir, f));
	const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" });
	git("init", "-q", "-b", "main");
	git("add", "-A");
	git("commit", "-qm", "init");
}

/** A stand-in for the omp extension host that keeps the two registered handlers. */
class Host implements Api {
	zod = z;
	onCall?: CallHandler;
	onResult?: ResultHandler;

	on(event: "tool_call", h: CallHandler): void;
	on(event: "tool_result", h: ResultHandler): void;
	on(event: "tool_call" | "tool_result", h: CallHandler | ResultHandler): void {
		if (event === "tool_result") {
			// SAFETY: the overloads above pair "tool_result" with a ResultHandler.
			this.onResult = h as ResultHandler;

			return;
		}

		// SAFETY: the overloads above pair "tool_call" with a CallHandler.
		this.onCall = h as CallHandler;
	}
}

function load(roots: string[] = []) {
	const host = new Host();
	pathGuard(host, { roots });
	const ctx = { cwd: code };
	let n = 0;

	const call = (toolName: string, input: Input) => host.onCall?.({ toolName, toolCallId: `c${++n}`, input }, ctx);

	const result = (toolName: string, input: Input, text: string, isError: boolean, id = `r${++n}`) =>
		host.onResult?.({ toolName, toolCallId: id, input, content: [{ type: "text", text }], isError }, ctx);

	const pathAfter = (toolName: string, input: Input) => {
		const out = call(toolName, input);

		return out ? z.object({ path: z.string() }).parse(out.input).path : undefined;
	};

	const lastText = (out: ResultOutcome | undefined) => out?.content.at(-1)?.text ?? "";

	return { host, call, result, pathAfter, lastText };
}

beforeAll(() => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "path-guard-")));
	code = join(base, "work", "checkout");
	docs = join(base, "work", "docs-checkout");
	repo(code, ["app/code/Model/Provider/Product/Attributes.php", "README.md"]);
	repo(docs, ["docs/ai/OPERATING-SYSTEM.md", "scripts/ai/release_train.py", "packet/STATUS.json", "AGENTS.md"]);
	wt = join(base, "work", "docs-worktrees", "fix-1");
	execFileSync("git", ["-C", docs, "worktree", "add", "-q", wt, "-b", "fix-1"], { stdio: "pipe" });
	put(join(wt, "docs/ai/work/T-1/packet.md"));
	put(join(wt, "docs/ai/OPERATING-SYSTEM.md"), "worktree copy\n");
	other = join(base, "work", "mirror");
	repo(other, ["docs/ai/OPERATING-SYSTEM.md"]);
	codeWt = join(base, "work", "checkout-wt");
	execFileSync("git", ["-C", code, "worktree", "add", "-q", codeWt, "-b", "feature"], { stdio: "pipe" });
	put(join(codeWt, "feature/new.ts"));
	symlinkSync(join(base, "work"), join(base, "link"));
	plain = join(base, "work", "plain");
	put(join(plain, "docs/ai/OPERATING-SYSTEM.md"));
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("read: wrong checkout", () => {
	test("a repo-relative path missing in the cwd repo is read from the configured companion root", () => {
		const { call } = load([docs]);
		const out = call("read", { path: "docs/ai/OPERATING-SYSTEM.md:10-20", i: "intent" });
		expect(out).toEqual({ input: { path: join(docs, "docs/ai/OPERATING-SYSTEM.md") + ":10-20", i: "intent" } });
	});

	test("an absolute path into the cwd checkout is moved to the companion root", () => {
		const { pathAfter } = load([docs]);
		expect(pathAfter("read", { path: join(code, "scripts/ai/release_train.py") })).toBe(
			join(docs, "scripts/ai/release_train.py"),
		);
	});

	test("a grep keeps its other options when its path is moved", () => {
		const { call } = load([docs]);
		const out = call("grep", { path: join(code, "scripts/ai/release_train.py"), pattern: "x", case: "true" });
		expect(out).toEqual({ input: { path: join(docs, "scripts/ai/release_train.py"), pattern: "x", case: "true" } });
	});

	test("a path written through a symlinked parent still finds its checkout", () => {
		const { pathAfter } = load([docs]);
		expect(pathAfter("read", { path: join(base, "link", "checkout", "scripts/ai/release_train.py") })).toBe(
			join(docs, "scripts/ai/release_train.py"),
		);
	});

	test("the root the session used most recently wins over the configured root", () => {
		const { result, pathAfter } = load([docs]);
		const packet = join(wt, "docs/ai/work/T-1/packet.md");
		result("read", { path: packet }, `[${packet}#AB12]\n1:x`, false);
		expect(pathAfter("read", { path: "docs/ai/OPERATING-SYSTEM.md" })).toBe(join(wt, "docs/ai/OPERATING-SYSTEM.md"));
	});

	test("the result says which path was used instead", () => {
		const { call, result } = load([docs]);
		call("read", { path: "docs/ai/OPERATING-SYSTEM.md" });
		const out = result("read", {}, "body", false, "c1");
		expect(out?.content[0].text).toContain(`used '${join(docs, "docs/ai/OPERATING-SYSTEM.md")}'`);
	});

	test("without a companion root nothing is rewritten", () => {
		const { call } = load([]);
		expect(call("read", { path: "docs/ai/OPERATING-SYSTEM.md" })).toBeUndefined();
	});

	test("a bare root file name is never swapped for another repository's file of that name", () => {
		const { call, result, lastText } = load([docs]);
		const guess = join(code, "AGENTS.md");
		expect(call("read", { path: guess })).toBeUndefined();
		expect(lastText(result("read", { path: guess }, `Path '${guess}' not found`, true))).toContain(
			join(docs, "AGENTS.md"),
		);
	});

	test("a path inside one worktree is not swapped for a sibling worktree of the same repository", () => {
		const { call, result } = load([docs]);
		const packet = join(wt, "docs/ai/work/T-1/packet.md");
		result("read", { path: packet }, `[${packet}#AB12]\n1:x`, false);
		expect(call("read", { path: join(docs, "docs/ai/work/T-1/packet.md") })).toBeUndefined();
	});

	test("a relative path is not moved to a sibling worktree of the cwd repository", () => {
		const { call, result } = load([docs]);
		const fresh = join(codeWt, "feature/new.ts");
		result("read", { path: fresh }, `[${fresh}#CD34]\n1:x`, false);
		expect(call("read", { path: "feature/new.ts" })).toBeUndefined();
	});

	test("a root outside git proves nothing, so its copy is listed, not chosen", () => {
		const { call } = load([plain]);
		expect(call("read", { path: "docs/ai/OPERATING-SYSTEM.md" })).toBeUndefined();
	});

	test("a relative path that two other repositories hold is listed, not chosen", () => {
		const { call, result, lastText } = load([docs, other]);
		expect(call("read", { path: "docs/ai/OPERATING-SYSTEM.md" })).toBeUndefined();
		const text = lastText(result("read", { path: "docs/ai/OPERATING-SYSTEM.md" }, "Path not found", true));
		expect(text).toContain(join(docs, "docs/ai/OPERATING-SYSTEM.md"));
		expect(text).toContain(join(other, "docs/ai/OPERATING-SYSTEM.md"));
	});

	test("a wide grep does not change which root the session is working in", () => {
		const { result, pathAfter } = load([docs]);
		const hit = join(wt, "docs/ai/work/T-1/packet.md");
		result("grep", { path: wt }, `[${hit}#EF56]\n1:x`, false);
		expect(pathAfter("read", { path: "docs/ai/OPERATING-SYSTEM.md" })).toBe(join(docs, "docs/ai/OPERATING-SYSTEM.md"));
	});
});

describe("read: typos", () => {
	test("one misspelled directory is corrected when the rest of the path exists", () => {
		const { pathAfter } = load();
		const typo = join(base, "work", "docs-chekout", "docs/ai/OPERATING-SYSTEM.md");
		expect(pathAfter("read", { path: typo })).toBe(join(docs, "docs/ai/OPERATING-SYSTEM.md"));
	});

	test("a removed worktree directory is not 'corrected' to the main checkout", () => {
		const { call } = load();
		const stale = join(base, "work", "docs-checkout-wt-old", "docs/ai/OPERATING-SYSTEM.md");
		expect(call("read", { path: stale })).toBeUndefined();
	});

	test("a wrong file name is not guessed; the error lists the real neighbour", () => {
		const { call, result, lastText } = load();
		const guess = join(docs, "packet/STATUS.md");
		expect(call("read", { path: guess })).toBeUndefined();
		expect(lastText(result("read", { path: guess }, `Path '${guess}' not found`, true))).toContain(
			join(docs, "packet/STATUS.json"),
		);
	});

	test("a dropped directory segment is suggested from the repo's tracked files", () => {
		const { result, lastText } = load();
		const guess = join(code, "app/code/Model/Product/Attributes.php");
		expect(lastText(result("read", { path: guess }, `Path '${guess}' not found`, true))).toContain(
			join(code, "app/code/Model/Provider/Product/Attributes.php"),
		);
	});
});

describe("edit: header paths", () => {
	test("a bare file name is resolved through the snapshot tag the session saw", () => {
		const { call, result } = load();
		const packet = join(wt, "docs/ai/work/T-1/packet.md");
		result("grep", { path: wt }, `[${packet}#9F3C]\n1:x`, false);
		expect(call("edit", { input: "[packet.md#9F3C]\nPUT 1.=1:\n+y\n" })).toEqual({
			input: { input: `[${packet}#9F3C]\nPUT 1.=1:\n+y\n` },
		});
	});

	test("a tag that identical copies share does not pick one of them", () => {
		const { call, result } = load();
		const mine = join(wt, "docs/ai/work/T-1/packet.md");
		const copy = join(other, "docs/ai/work/T-1/packet.md");
		put(copy);
		result("read", { path: mine }, `[${mine}#AB12]\n1:x`, false);
		result("grep", { path: other }, `[${copy}#AB12]\n1:x`, false);
		expect(call("edit", { input: "[packet.md#AB12]\nPUT 1.=1:\n+y\n" })).toBeUndefined();
	});

	test("an unknown tag with no unique match is left for the tool to reject, then suggestions follow", () => {
		const { call, result, lastText } = load([docs]);
		const input = { input: "[docs/ai/work/T-1/packet.md#0000]\nPUT 1.=1:\n+y\n" };
		expect(call("edit", input)).toBeUndefined();
		expect(lastText(result("edit", input, "File not found: docs/ai/work/T-1/packet.md. Use the write tool", true))).toContain(
			join(wt, "docs/ai/work/T-1/packet.md"),
		);
	});
});

describe("bash: missing script", () => {
	test("a script run from the wrong checkout gets the real location", () => {
		const { result, lastText } = load([docs]);
		const text = `python3: can't open file '${join(code, "scripts/ai/release_train.py")}': [Errno 2] No such file`;
		expect(lastText(result("bash", { command: "python3 scripts/ai/release_train.py" }, text, true))).toContain(
			join(docs, "scripts/ai/release_train.py"),
		);
	});

	test("successful output and missing programs are left alone", () => {
		const { result } = load([docs]);
		const source = `print("can't open file '${join(code, "scripts/ai/release_train.py")}'")`;
		expect(result("bash", { command: "cat x.py" }, source, false)).toBeUndefined();
		expect(result("bash", { command: "python x" }, "env: 'python': No such file or directory", true)).toBeUndefined();
	});
});

describe("find: judge timeout", () => {
	const TIMEOUT = 'find timed out after 20.0s at "filename ranking 64/128", before any hit was verified.';
	let tree: string;

	beforeAll(() => {
		tree = join(base, "search");
		put(join(tree, "lease.md"), "quiet lease\nthe lease holder\nlease expiry\n");
		put(join(tree, "notes/queue.md"), "one lease line\n");
		put(join(tree, "other.md"), "nothing relevant\n");
	});

	test("a timed-out find lists the files that hold its words, most matches first", () => {
		const { result, lastText } = load();
		const text = lastText(result("find", { query: "where the lease is released", grep_keywords: [], path: tree }, TIMEOUT, true));
		expect(text).toContain("lease");
		expect(text.indexOf(join(tree, "lease.md"))).toBeGreaterThan(-1);
		expect(text.indexOf(join(tree, "lease.md"))).toBeLessThan(text.indexOf(join(tree, "notes/queue.md")));
		expect(text).not.toContain("other.md");
	});

	test("a find that answered, or failed for another reason, is left alone", () => {
		const { result } = load();
		expect(result("find", { query: "lease", grep_keywords: [], path: tree }, "1 hit(s) for lease", false)).toBeUndefined();
		expect(result("find", { query: "lease", grep_keywords: [], path: "skill://x" }, TIMEOUT, true)).toBeUndefined();
	});

	test("a timed-out find on one file lists its matching lines", () => {
		const { result, lastText } = load();
		const file = join(tree, "lease.md");
		const text = lastText(result("find", { query: "lease expiry", grep_keywords: [], path: file }, TIMEOUT, true));
		expect(text).toContain("L3: lease expiry");
		expect(text).toContain("L1: quiet lease");
	});

	test("without rg the same ranking comes from grep", () => {
		const bin = mkdtempSync(join(tmpdir(), "no-rg-"));
		symlinkSync(execFileSync("which", ["grep"], { encoding: "utf8" }).trim(), join(bin, "grep"));
		const savedPath = process.env.PATH;
		process.env.PATH = bin;

		try {
			expect(lexicalMatches(tree, ["lease"])?.map(m => m.path)).toEqual([join(tree, "lease.md"), join(tree, "notes/queue.md")]);
		} finally {
			process.env.PATH = savedPath;
			rmSync(bin, { recursive: true, force: true });
		}
	});

	test("a search that errors after some matches adds nothing", () => {
		const bin = mkdtempSync(join(tmpdir(), "rg-err-"));
		writeFileSync(join(bin, "rg"), `#!/bin/sh\necho "${join(tree, "lease.md")}:3"\nexit 2\n`);
		chmodSync(join(bin, "rg"), 0o755);
		const savedPath = process.env.PATH;
		process.env.PATH = `${bin}:${savedPath}`;

		try {
			expect(lexicalMatches(tree, ["lease"])).toBeUndefined();
		} finally {
			process.env.PATH = savedPath;
			rmSync(bin, { recursive: true, force: true });
		}
	});

	test("a find on a missing path still gets the closest real paths", () => {
		const { result, lastText } = load();
		const guess = join(docs, "packet/STATUS.md");
		expect(lastText(result("find", { query: "status", grep_keywords: [], path: guess }, `Path not found: ${guess}`, true))).toContain(
			join(docs, "packet/STATUS.json"),
		);
	});
});

describe("bash: GitHub owner typo", () => {
	test("a 404 for joshuawarren/<repo> names the real owner", () => {
		const { result, lastText } = load();
		const out = result("bash", { command: "gh api repos/joshuawarren/blend/pulls/12" }, "gh: Not Found (HTTP 404)", true);
		expect(lastText(out)).toContain("joshuaswarren/blend");
		const curl = result("bash", { command: "curl -s https://api.github.com/repos/Joshuawarren/remnic" }, '{"message": "Not Found"}', false);
		expect(lastText(curl)).toContain("joshuaswarren/remnic");
	});

	test("home paths, the right owner and successful calls are left alone", () => {
		const { result } = load();
		const home = "ls /home/joshuawarren/src && gh api repos/joshuaswarren/blend";
		expect(result("bash", { command: home }, "gh: Not Found (HTTP 404)", true)).toBeUndefined();
		expect(result("bash", { command: "gh repo view joshuawarren/blend" }, "blend\tprivate", false)).toBeUndefined();
	});
});

describe("bash: home directory typo", () => {
	const home = homedir();
	const typo = join(dirname(home), `${basename(home).slice(0, 3)}os${basename(home).slice(3)}`);

	const failed = (input: Input) => {
		const { call, result, lastText } = load();
		expect(call("bash", input)).toBeUndefined();

		return lastText(result("bash", input, "No such file or directory", true));
	};

	test("a failed command with a misspelled home in its path or cwd names the real home, and nothing is rewritten", () => {
		expect(failed({ command: `tail -5 ${typo}/.remnic/logs/daemon.log` })).toContain(`'${typo}' does not exist; the home directory is '${home}'`);
		expect(failed({ command: "make", cwd: `${typo}/src` })).toContain(`the home directory is '${home}'`);
	});

	test("the real home, other users, longer names and successful commands get no hint", () => {
		expect(failed({ command: `ls ${home}/src` })).not.toContain("home directory is");
		expect(failed({ command: `ls ${join(dirname(home), "alice")}` })).not.toContain("home directory is");
		expect(failed({ command: `ls ${home}extra-long-suffix/x /var${home}x ${home}x+backup/y` })).not.toContain("home directory is");
		const { result } = load();
		expect(result("bash", { command: `ls ${typo}` }, "ok", false)).toBeUndefined();
	});

	test("quoted text, heredocs, comments and remote commands get no hint", () => {
		for (const command of [
			`agent-note mistake "Used ${typo} instead of ${home}"`,
			`printf '%s\\n' '${typo}/file'`,
			`cat > f <<'EOF'\n${typo}/x\nEOF`,
			`ls  # ${typo}`,
			`ssh host ls ${typo}/x`,
			`scp f host:${typo}/x`,
		]) {
			expect(failed({ command })).not.toContain("home directory is");
		}
	});
});

describe("leaves real paths alone and fails open", () => {
	const SLOW_GIT_TEST_MS = 15_000; // two git calls are killed at 2 s each

	test("a git lookup killed by its timeout blocks the rewrite once and is asked again later", () => {
		const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
		const bin = mkdtempSync(join(tmpdir(), "slow-git-"));
		const fake = join(bin, "git");
		writeFileSync(fake, `#!/bin/sh\ncase "$*" in *--git-common-dir*) sleep 3;; esac\nexec "${realGit}" "$@"\n`);
		chmodSync(fake, 0o755);
		const { call } = load([docs]);
		const savedPath = process.env.PATH;
		process.env.PATH = `${bin}:${savedPath}`;

		try {
			expect(call("read", { path: "scripts/ai/release_train.py" })).toBeUndefined();
		} finally {
			process.env.PATH = savedPath;
			rmSync(bin, { recursive: true, force: true });
		}

		expect(call("read", { path: "scripts/ai/release_train.py" })).toEqual({
			input: { path: join(docs, "scripts/ai/release_train.py") },
		});
	}, SLOW_GIT_TEST_MS);

	test("existing paths, internal URLs and globs are untouched", () => {
		const { call } = load([docs]);
		expect(call("read", { path: "README.md" })).toBeUndefined();
		expect(call("read", { path: "skill://x/README.md" })).toBeUndefined();
		expect(call("glob", { path: "docs/**/nope*.md" })).toBeUndefined();
	});

	test("a malformed event never throws or blocks", () => {
		const { call, result } = load([docs]);
		expect(call("read", { path: 42 })).toBeUndefined();
		expect(call("edit", {})).toBeUndefined();
		expect(result("read", { path: ["x"] }, "Path 'x' not found", true)).toBeUndefined();
	});
});
