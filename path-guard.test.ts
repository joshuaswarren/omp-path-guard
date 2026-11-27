import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import * as z from "@oh-my-pi/omptype/zod";

import pathGuard, { type Api, type CallHandler, lexicalMatches, type ResultHandler, type ResultOutcome, restFallback } from "./path-guard";

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

		return out && "input" in out ? z.object({ path: z.string() }).parse(out.input).path : undefined;
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

	test("after a timeout, the next find in the session gets the literal answer at once instead of a second 20 s wait", () => {
		const { call, result } = load();
		expect(call("find", { query: "lease expiry", grep_keywords: [], path: tree })).toBeUndefined();
		result("find", { query: "where the lease is released", grep_keywords: [], path: tree }, TIMEOUT, true);
		const next = call("find", { query: "lease expiry", grep_keywords: [], path: tree });
		expect(next).toMatchObject({ block: true });
		const reason = next && "reason" in next ? next.reason : "";
		expect(reason).toContain("timed out in this session");
		expect(reason).toContain(join(tree, "lease.md"));
		expect(reason).not.toContain("other.md");
		expect(call("find", { query: "lease expiry", grep_keywords: [], path: tree })).toBeUndefined();
	});

	test("a find that answers after a timeout ends the hold", () => {
		const { call, result } = load();
		result("find", { query: "lease", grep_keywords: [], path: tree }, TIMEOUT, true);
		result("find", { query: "lease", grep_keywords: [], path: tree }, "1 hit(s) for lease", false);
		expect(call("find", { query: "lease expiry", grep_keywords: [], path: tree })).toBeUndefined();
	});

	test("a find that answered, a partial or quoted timeout, or a scope with no literal search runs unchanged", () => {
		const { call, result } = load();
		result("find", { query: "lease", grep_keywords: [], path: tree }, "1 hit(s) for lease", false);
		result("find", { query: "lease", grep_keywords: [], path: tree }, "partial: timed out after 20.0s with 1 of 4 passages verified", false);
		result("find", { query: "timeout text", grep_keywords: [], path: tree }, `1 hit(s): notes.md:3 ${TIMEOUT}`, false);
		expect(call("find", { query: "lease expiry", grep_keywords: [], path: tree })).toBeUndefined();
		result("find", { query: "lease", grep_keywords: [], path: tree }, TIMEOUT, true);
		expect(call("find", { query: "lease expiry", grep_keywords: [], path: "skill://x" })).toBeUndefined();
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

describe("bash: GitHub GraphQL budget spent", () => {
	const limit = "GraphQL: API rate limit already exceeded for user ID 816217.";

	test("the refusal gives the REST form, and a gh pr retry in the same session is refused with it", () => {
		const { call, result, lastText } = load();
		const docs = "joshuaswarren/blend-adobe-commerce-docs";
		const out = result("bash", { command: `gh pr checks 5030 --repo ${docs}` }, limit, true);
		expect(lastText(out)).toContain(`gh api repos/${docs}/commits/$(gh api repos/${docs}/pulls/5030 --jq .head.sha)/check-runs`);
		const retry = call("bash", { command: "gh pr view 5031" });
		expect(retry).toMatchObject({ block: true });
		expect(retry && "reason" in retry ? retry.reason : "").toContain("gh api repos/{owner}/{repo}/pulls/5031");
		expect(call("bash", { command: "gh pr merge 5031 --squash" })).toMatchObject({ block: true });
	});

	test("REST calls, other errors and a session without the refusal run unchanged", () => {
		const { call, result } = load();
		expect(call("bash", { command: "gh pr view 5031" })).toBeUndefined();
		expect(result("bash", { command: "gh pr view 5031" }, "GraphQL: Could not resolve to a PullRequest", true)).toBeUndefined();
		expect(call("bash", { command: "gh pr view 5031" })).toBeUndefined();
		result("bash", { command: "gh pr checks 1" }, limit, true);
		expect(call("bash", { command: "gh api repos/joshuaswarren/blend/pulls/1" })).toBeUndefined();
		expect(call("bash", { command: 'echo "gh pr view 5031"' })).toBeUndefined();
	});

	test("the REST form reads its own command's PR number, repository and merge method", () => {
		expect(restFallback("gh pr checks --repo org/repo 5030")).toContain("repos/org/repo/pulls/5030");
		expect(restFallback("gh pr checks --interval 10 5004 --watch")).toContain("pulls/5004 ");
		expect(restFallback("gh pr view https://github.com/org/repo/pull/7")).toBe("gh api repos/{owner}/{repo}/pulls/7");
		expect(restFallback("gh pr merge 5030 --delete-branch")).toContain("merge_method=merge ");
		expect(restFallback("gh pr merge 5030 -R org/repo --squash")).toContain("repos/org/repo/pulls/5030/merge -f merge_method=squash");
		expect(restFallback("gh pr view 5031; gh issue list -R other/repo")).toBe("gh api repos/{owner}/{repo}/pulls/5031");
		expect(restFallback("gh pr merge 5031 --disable-auto")).toBeUndefined();
		expect(restFallback("gh pr merge 5031 --auto --squash")).toBeUndefined();
	});
});

describe("bash: herdr agent list shape", () => {
	test("a guessed subcommand, flag or JSON root gets the real command and shape", () => {
		const { result, lastText } = load();
		const unknown = result("bash", { command: "herdr agents --json" }, "unknown command: agents\nrun 'herdr --help' for usage", false);
		expect(lastText(unknown)).toContain(".result.agents[]");
		const flag = result("bash", { command: "herdr agent list --json" }, "usage: herdr agent list", true);
		expect(lastText(flag)).toContain("already prints JSON");
		const root = 'jq: error (at <stdin>:1): Cannot index string with string "pane_id"';
		expect(lastText(result("bash", { command: "herdr agent list | jq -r '.[] | .pane_id'" }, root, true))).toContain(".result.agents[]");
	});

	test("a right filter, other jq errors and other commands get no hint", () => {
		const { result } = load();
		const root = 'jq: error (at <stdin>:1): Cannot index string with string "pane"';
		expect(result("bash", { command: "herdr agent list | jq '.result.agents[] | .pane'" }, root, true)).toBeUndefined();
		expect(result("bash", { command: "cat x.json | jq '.[] | .pane'" }, root, true)).toBeUndefined();
		expect(result("bash", { command: "herdr agent list" }, '{"id":"cli:agent:list"}', false)).toBeUndefined();
	});
});

describe("bash: pop after a stash that saved nothing", () => {
	let stashed: string;

	beforeAll(() => {
		stashed = join(base, "stashed");
		repo(stashed, ["a.txt"]);
		put(join(stashed, "a.txt"), "old lane work\n");
		execFileSync("git", ["-C", stashed, "stash", "push", "-qm", "old lane stash"], { stdio: "pipe" });
	});

	test("a bare pop after 'No local changes to save' is refused once and names the old stash", () => {
		const { call, result } = load();
		result("bash", { command: "git stash", cwd: stashed }, "No local changes to save", false);
		const pop = call("bash", { command: "git stash pop", cwd: stashed });
		expect(pop).toMatchObject({ block: true });
		expect(pop && "reason" in pop ? pop.reason : "").toContain("old lane stash");
		expect(call("bash", { command: "git stash pop", cwd: stashed })).toBeUndefined();
	});

	test("a named stash, a stash that saved work, and other repositories run unchanged", () => {
		const { call, result } = load();
		expect(call("bash", { command: "git stash pop", cwd: stashed })).toBeUndefined();
		result("bash", { command: "git stash", cwd: stashed }, "No local changes to save", false);
		expect(call("bash", { command: "git stash pop stash@{0}", cwd: stashed })).toBeUndefined();
		expect(call("bash", { command: "git stash pop", cwd: code })).toBeUndefined();
		result("bash", { command: "git stash", cwd: stashed }, "Saved working directory and index state WIP on main", false);
		expect(call("bash", { command: "git stash pop", cwd: stashed })).toBeUndefined();
	});

	test("-C and cd name the repository on both sides; redirects do not hide the pop", () => {
		const { call, result } = load();
		result("bash", { command: `git -C ${stashed} stash`, cwd: code }, "No local changes to save", false);
		const pop = call("bash", { command: `cd ${stashed} && git stash pop 2>&1`, cwd: code });
		expect(pop && "reason" in pop ? pop.reason : "").toContain("old lane stash");
		expect(call("bash", { command: `cd ${stashed} && git stash pop 2>&1`, cwd: code })).toBeUndefined();

		const second = load();
		second.result("bash", { command: `cd ${stashed}; git --no-pager stash`, cwd: code }, "No local changes to save", false);
		expect(second.call("bash", { command: `(cd ${stashed} && git stash pop)`, cwd: code })).toMatchObject({ block: true });
	});

	test("a stash and a bare pop in one command are refused on a clean tree and run on a dirty one", () => {
		const { call } = load();
		const pop = call("bash", { command: "git stash && git pull --rebase && git stash pop", cwd: stashed });
		expect(pop && "reason" in pop ? pop.reason : "").toContain("old lane stash");

		const dirty = join(base, "dirty-stash");
		repo(dirty, ["a.txt"]);
		put(join(dirty, "a.txt"), "older work\n");
		execFileSync("git", ["-C", dirty, "stash", "push", "-qm", "older stash"], { stdio: "pipe" });
		put(join(dirty, "a.txt"), "current work\n");
		expect(call("bash", { command: "git stash && git pull --rebase && git stash pop", cwd: dirty })).toBeUndefined();
		expect(call("bash", { command: "echo new > a.txt && git stash && git stash pop", cwd: stashed })).toBeUndefined();
		expect(call("bash", { command: "git stash push -- a.txt && git stash pop", cwd: stashed })).toBeUndefined();
		expect(call("bash", { command: "git --no-pager stash && git stash pop", cwd: stashed })).toMatchObject({ block: true });
	});

	test("quoted text that names git stash marks nothing", () => {
		const { call, result } = load();
		result("bash", { command: 'echo "git stash"', cwd: stashed }, "No local changes to save", false);
		expect(call("bash", { command: "git stash pop", cwd: stashed })).toBeUndefined();
	});

	test("each push's own output marks its repository", () => {
		const { call, result } = load();
		const output = "No local changes to save\nSaved working directory and index state WIP on main";
		result("bash", { command: `git -C ${stashed} stash; git -C ${code} stash`, cwd: base }, output, false);
		expect(call("bash", { command: `git -C ${stashed} stash pop`, cwd: base })).toMatchObject({ block: true });

		const quiet = load();
		quiet.result("bash", { command: `git -C ${stashed} stash -q; git -C ${code} stash`, cwd: base }, "No local changes to save", false);
		expect(quiet.call("bash", { command: `git -C ${stashed} stash pop`, cwd: base })).toBeUndefined();
	});
});

describe("bash: git write after a cd that may fail", () => {
	test("a cd into a missing directory, not joined by &&, is refused once before a git write", () => {
		const { call } = load();
		const command = `git worktree add ${base}/probe-wt main; cd ${base}/probe-wt; git sparse-checkout set docs`;
		const held = call("bash", { command, cwd: code });
		expect(held && "reason" in held ? held.reason : "").toContain(`'${code}'`);
		expect(call("bash", { command, cwd: code })).toBeUndefined();
		expect(call("bash", { command: `cd ${base}/gone && echo hi; git checkout main`, cwd: code })).toMatchObject({ block: true });
	});

	test("&&, set -e, exit, -C, an existing directory, and quoted text run unchanged", () => {
		const { call } = load();

		for (const command of [
			`mkdir -p ${base}/made && cd ${base}/made && git init`,
			`set -euo pipefail; cd ${base}/gone; git commit -m x`,
			`set -o errexit; cd ${base}/gone; git commit -m x`,
			"cd -; git commit -m x",
			"cd $WORKTREE; git reset --hard",
			`cd ${base}/gone || exit 1; git reset --hard`,
			`cd ${base}/gone; git -C ${code} reset --hard`,
			`cd ${code}; git reset --hard`,
			`cd ${base}/gone; git status`,
			`echo "cd ${base}/gone; git reset --hard"`,
		]) {
			expect(call("bash", { command, cwd: code })).toBeUndefined();
		}
	});
});

describe("bash: a commit the clone does not hold", () => {
	test("git's error names a missing commit: the result says to fetch; local objects, numbers, -C, and non-repositories get nothing", () => {
		const { result, lastText } = load();
		const head = execFileSync("git", ["-C", code, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
		const blob = execFileSync("git", ["-C", code, "rev-parse", "HEAD:"], { encoding: "utf8" }).trim();
		const missing = result("bash", { command: "git merge-base --is-ancestor ddd95a7 HEAD", cwd: code }, "fatal: Not a valid object name ddd95a7", true);
		expect(lastText(missing)).toContain("'ddd95a7' names no object in the clone");
		expect(lastText(missing)).toContain("git fetch origin ddd95a7");

		for (const [command, text, cwd] of [
			[`git show ${head}:nope`, `fatal: path 'nope' does not exist in '${head}'`, code],
			[`git log ${blob}`, `fatal: bad object ${blob}`, code],
			["curl https://example.com", "error: token f47ac10b0e02 expired at 1764250000", code],
			["git push origin main", "error: request f47ac10b-58cc-4372-a567-0e02b2c3d479 rate-limited", code],
			[`git -C ${base} log ddd95a7`, "fatal: bad object ddd95a7", code],
			[`git -C${base} log ddd95a7`, "fatal: bad object ddd95a7", code],
			[`git --git-dir=${base}/.git log ddd95a7`, "fatal: bad object ddd95a7", code],
			[`cd ${base} && git log ddd95a7`, "fatal: bad object ddd95a7", code],
			[`bash -c 'cd ${base} && git log ddd95a7'`, "fatal: bad object ddd95a7", code],
			["git status && ./deploy.sh", "error: checksum f47ac10 mismatch", code],
			["git log ddd95a7", "fatal: not a git repository; ddd95a7", base],
		]) {
			expect(lastText(result("bash", { command, cwd }, text, true))).not.toContain("names no object");
		}
	});
});

describe("bash: hand-completed SHA", () => {
	// The real SHA's first 10 characters, then 30 that differ from it.
	const invent = (real: string) => real.slice(0, 10) + (real[10] === "0" ? "1" : "0").repeat(30);

	test("a full SHA built on a real short SHA is refused, and the real one is named", () => {
		const { call } = load();
		const real = execFileSync("git", ["-C", code, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
		const bad = invent(real);
		const out = call("bash", { command: `gh api repos/joshuaswarren/blend/commits/${bad}/check-runs` });
		expect(out).toMatchObject({ block: true });
		expect(out && "reason" in out ? out.reason : "").toContain(real);
		const merge = call("bash", { command: `gh pr merge 12 --squash --match-head-commit "${bad}"`, cwd: code });
		expect(merge).toMatchObject({ block: true });
	});

	test("real SHAs, unknown SHAs, notes and commands outside a repository run unchanged", () => {
		const { call } = load();
		const real = execFileSync("git", ["-C", code, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
		expect(call("bash", { command: `gh api repos/joshuaswarren/blend/commits/${real}/check-runs` })).toBeUndefined();
		expect(call("bash", { command: `git show ${"f".repeat(40)}` })).toBeUndefined();
		expect(call("bash", { command: `~/.local/bin/agent-note mistake 'used ${invent(real)}'` })).toBeUndefined();
		expect(call("bash", { command: `git show ${invent(real)}`, cwd: plain })).toBeUndefined();
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

describe("read: ssh:// size cap", () => {
	const file = "/home/u/.local/state/agent-notes/notes.jsonl";
	const CAP = `ssh://: ${file} exceeds the 1 MiB limit; ssh:// supports text files up to 1 MiB — use an sshfs mount for larger files`;

	const hint = (path: string) => {
		const { result, lastText } = load();

		return lastText(result("read", { path }, CAP, true));
	};

	test("a remote file over the cap gets a bash command for the part that was asked for", () => {
		expect(hint("ssh://host-a/~/.local/state/agent-notes/notes.jsonl:-20")).toContain(`ssh host-a 'tail -n 20 ${file}'`);
		expect(hint("ssh://host-a/~/.local/state/agent-notes/notes.jsonl:40-60")).toContain(`ssh host-a 'sed -n 40,60p ${file}'`);
		expect(hint("ssh://host-a/~/.local/state/agent-notes/notes.jsonl")).toContain(`ssh host-a 'head -n 200 ${file}'`);
	});

	test("other ssh:// errors and local reads get no command", () => {
		const { result, lastText } = load();
		expect(lastText(result("read", { path: "ssh://host-a/x" }, "ssh://: permission denied", true))).not.toContain("ssh host-a");
		expect(lastText(result("read", { path: "/tmp/big.log" }, CAP, true))).not.toContain("ssh ");
		const evil = "ssh://: /tmp/$(touch x).log exceeds the 1 MiB limit; ssh:// supports text files up to 1 MiB";
		expect(lastText(result("read", { path: "ssh://host-a/tmp/$(touch x).log" }, evil, true))).not.toContain("ssh host-a");
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
