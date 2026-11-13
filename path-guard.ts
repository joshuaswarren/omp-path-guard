// path-guard: an omp extension that removes the "guessed path" round trip.
//
// When a model calls read/grep/glob/find/edit with a path that does not exist,
// the built-in tools answer "not found" and nothing else, so the model guesses
// again. This extension:
//   1. rewrites the call before it runs when the real path is provable:
//      - edit: the hashline header `[path#TAG]` names a snapshot tag this
//        session already saw, and that file has the same name;
//      - read/grep/glob/find: the same repo-relative path (with a directory
//        part) exists under a root the session already used, the cwd repo,
//        or a configured companion checkout of another repository; or one
//        misspelled directory name is the only way the rest of the path exists;
//   2. otherwise appends the closest real paths to the not-found error, so the
//      next call can be right;
//   3. does the same for bash commands that fail to open a script file;
//   4. refuses a bash command whose full SHA is a known short SHA completed by
//      hand, and names the real commit.
// Every handler fails open: an internal error never blocks or alters a call.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

import type * as Zod from "@oh-my-pi/omptype/zod";

/** A content block of a tool result. Image blocks pass through untouched. */
interface Block {
	type: string;
	text?: string;
}

export interface ToolEvent {
	toolName: string;
	toolCallId: string;
	input: object;
}

export interface ToolResultEvent extends ToolEvent {
	content: Block[];
	isError: boolean;
}

export interface Ctx {
	cwd: string;
}

/** A rewritten input, or a refusal whose reason the model reads instead of a result. */
export type CallOutcome = { input: object } | { block: true; reason: string };

export interface ResultOutcome {
	content: Block[];
}

/** The part of omp's ExtensionAPI this extension uses. */
export interface Api {
	zod: typeof Zod;
	on(event: "tool_call", h: CallHandler): void;
	on(event: "tool_result", h: ResultHandler): void;
}

export type CallHandler = (e: ToolEvent, ctx: Ctx) => CallOutcome | undefined;

export type ResultHandler = (e: ToolResultEvent, ctx: Ctx) => ResultOutcome | undefined;

export interface GuardConfig {
	/** Companion checkouts of other repositories, tried after the roots the session used. `~` expands. */
	roots?: string[];
}

export interface Resolution {
	path: string;
	why: string;
}

const PATH_TOOLS = new Set(["read", "grep", "glob", "find"]);
const MAX_SUGGESTIONS = 6;
const MAX_TYPO_EDITS = 2;
const MAX_RECENT = 300;
const RECENT_ROOTS = 40;
const GIT_TIMEOUT_MS = 2000;

/** All git work one handler call may do; omp's own tool_call budget is 30 s. */
const HANDLER_BUDGET_MS = 4000;
const MAX_NOTICES = 100;
const MAX_LS_FILES = 400_000;
const NOT_FOUND = /not found|no such file|does not exist|ENOENT/i;
const SSH_CAP = /^ssh:\/\/: (\/\S+) exceeds the 1 MiB limit/;
const SSH_URL = /^ssh:\/\/([^/\s]+)\/.*?(?::(-\d+|\d+-\d+))?$/;
const REMOTE_HEAD_LINES = 200;
const SHELL_SAFE = /^[\w@%+=:,./~-]+$/;
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const GLOB_CHARS = /[*?[\]{}]/;
const READ_SELECTOR = /^(.*?)((?::(?:raw|conflicts|img|-?\d[\d+,-]*-?(?::raw)?))+)$/;
const EDIT_HEADER = /^\[([^\]\n]+)#([0-9A-Fa-f]{4})\][ \t]*$/gm;
const SNAPSHOT_HEADER = /^\[([^\]\n]+)#([0-9A-F]{4})\]/gm;

const BASH_MISSING = [
	/can't open file '([^']+)'/g,
	/Could not open input file: (\S+)/g,
	/^(?:\/bin\/)?(?:bash|sh|zsh): (?:line \d+: )?([^\s:'"]+): No such file or directory/gm,
];

const FIND_TIMED_OUT = /find timed out after/;

// A cold whole-repository rg took over 4 s live; the find it follows already used 20 s.
const FALLBACK_TIMEOUT_MS = 8000;
const MAX_FALLBACK_FILES = 8;
const MAX_KEYWORDS = 8;
const QUERY_WORD = /[a-z0-9_][a-z0-9_.-]{3,}/g;
const STOPWORDS = new Set(["that", "this", "with", "from", "into", "where", "which", "what", "when", "does", "code", "file", "files"]);

/** A GitHub owner slug one letter short of `joshuaswarren`; the real `Joshuawarren` account is someone else's. */
const OWNER_TYPO = /(?:github\.com[:/]|\brepos\/|(?:^|\s)(?:-R|--repo)(?:\s+|=)['"]?|\bgh\s+repo\s+\w+\s+['"]?)joshuawarren\/([\w.-]+)/gi;
const GH_NOT_FOUND = /Not Found|HTTP 404|Could not resolve to a Repository|Repository not found/i;
const REMOTE_COMMAND = /(?:^|[\s;&|(])(?:ssh|scp|rsync|sftp)(?:\s|$)/;
const MAX_HOME_EDITS = 2;
const GRAPHQL_LIMIT = /GraphQL: API rate limit (?:already )?exceeded/i;
const GH_PR = /\bgh\s+pr\s+(checks|view|list|status|merge)\b/;
const GH_PR_NUMBER = /\bgh\s+pr\s+\w+\s+(\d+)\b/;
const GH_REPO_FLAG = /(?:^|\s)(?:-R|--repo)(?:\s+|=)['"]?([\w.-]+\/[\w.-]+)/;

// GitHub refills the GraphQL budget hourly; inside this window a gh pr retry fails the same way.
const GRAPHQL_HOLD_MS = 10 * 60_000;
const FULL_SHA = /(?<![0-9a-fA-F])[0-9a-f]{40}(?![0-9a-fA-F])/g;

// Shared leading characters that make "same commit" certain; below 8 a remote-only commit could collide.
const SHA_PREFIXES = [12, 10, 8];
const NOTE_COMMAND = /(?:^|[\s;&|(/])agent-note(?:\s|$)/;

export function expandHome(p: string): string {
	if (p === "~") return homedir();

	return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

export function toAbs(p: string, cwd: string): string {
	const e = expandHome(p);

	return normalize(isAbsolute(e) ? e : resolve(cwd, e));
}

/** A single local path: no internal URL scheme, no `;` path list. */
function isLocalPath(p: string): boolean {
	return p.trim() !== "" && !SCHEME.test(p) && !p.includes(";") && !p.includes("\n");
}

/** Dice coefficient over character bigrams, case-insensitive. */
export function similarity(a: string, b: string): number {
	const x = a.toLowerCase();
	const y = b.toLowerCase();

	if (x === y) return 1;

	if (x.length < 2 || y.length < 2) return 0;
	const grams = new Map<string, number>();

	for (let i = 0; i < x.length - 1; i++) grams.set(x.slice(i, i + 2), (grams.get(x.slice(i, i + 2)) ?? 0) + 1);
	let hit = 0;

	for (let i = 0; i < y.length - 1; i++) {
		const g = y.slice(i, i + 2);
		const n = grams.get(g) ?? 0;

		if (n > 0) {
			hit++;
			grams.set(g, n - 1);
		}
	}

	return (2 * hit) / (x.length + y.length - 2);
}

/** Case-insensitive Levenshtein distance. */
export function editDistance(a: string, b: string): number {
	const x = a.toLowerCase();
	const y = b.toLowerCase();
	let prev = Array.from({ length: y.length + 1 }, (_, j) => j);

	for (let i = 1; i <= x.length; i++) {
		const row = [i];

		for (let j = 1; j <= y.length; j++) {
			row.push(Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1)));
		}

		prev = row;
	}

	return prev[y.length];
}

/**
 * Wall-clock end of the current handler's git budget; omp blocks a tool call whose tool_call handler
 * stalls. Each handler resets it; a direct PathGuard caller keeps the last value.
 */
let gitDeadline = Number.POSITIVE_INFINITY;

/** A git answer, or `answered: false` when the budget skipped the call or its timeout killed it. */
interface GitAnswer {
	answered: boolean;
	out?: string;
}

function git(args: string[], cwd: string): GitAnswer {
	const left = gitDeadline - Date.now();

	if (left <= 0) return { answered: false };

	try {
		const r = spawnSync("git", ["-c", "core.fsmonitor=false", "-C", cwd, ...args], {
			encoding: "utf8",
			timeout: Math.min(GIT_TIMEOUT_MS, left),
			maxBuffer: 64 * 1024 * 1024,
		});

		if (r.error || r.signal) return { answered: false };

		return { answered: true, out: r.status === 0 ? r.stdout : undefined };
	} catch {
		return { answered: false };
	}
}

/** Run git once per key; cache only real answers so a skipped or killed call is retried later. */
function cachedGit<T>(cache: Map<string, T | null>, key: string, args: string[], parse: (out: string) => T | null) {
	if (!cache.has(key)) {
		const r = git(args, key);

		if (!r.answered) return undefined;
		cache.set(key, r.out === undefined ? null : parse(r.out));
	}

	return cache.get(key) ?? undefined;
}

function isDir(p: string): boolean {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function listDir(p: string): string[] {
	try {
		return readdirSync(p);
	} catch {
		return [];
	}
}

export function nearestExisting(abs: string): string {
	let d = abs;

	while (!existsSync(d)) {
		const up = dirname(d);

		if (up === d) return d;
		d = up;
	}

	return d;
}

/** `abs` with its existing parents resolved through symlinks, as git reports roots. */
function realOf(abs: string): string {
	const existing = nearestExisting(abs);

	try {
		return join(realpathSync(existing), relative(existing, abs));
	} catch {
		return abs;
	}
}

function within(root: string, abs: string): boolean {
	return abs === root || abs.startsWith(root.endsWith(sep) ? root : root + sep);
}

export function loadConfig(z: typeof Zod, file = join(homedir(), ".omp", "agent", "path-guard.json")): GuardConfig {
	try {
		const parsed = z.object({ roots: z.array(z.string()).optional() }).safeParse(JSON.parse(readFileSync(file, "utf8")));

		return parsed.success ? parsed.data : {};
	} catch {
		return {};
	}
}

/** Per-session memory of real paths and snapshot tags, plus the path logic. */
export class PathGuard {
	/** Snapshot tag -> every file seen with it; identical copies in two worktrees share a tag. */
	readonly tags = new Map<string, Set<string>>();
	readonly recent: string[] = [];
	#top = new Map<string, string | null>();
	#common = new Map<string, string | null>();
	#worktrees = new Map<string, string[] | null>();
	#files = new Map<string, string[] | null>();
	#configRoots: string[];

	constructor(config: GuardConfig = {}) {
		this.#configRoots = (config.roots ?? []).map(expandHome).filter(isDir);
	}

	remember(abs: string): void {
		const i = this.recent.indexOf(abs);

		if (i >= 0) this.recent.splice(i, 1);
		this.recent.push(abs);

		if (this.recent.length > MAX_RECENT) this.recent.shift();
	}

	/**
	 * Record `[path#TAG]` snapshot headers from a successful result. Only files the
	 * agent read or edited count as recent; a wide grep must not reorder the roots.
	 */
	rememberSnapshots(text: string, cwd: string, focused: boolean): void {
		for (const m of text.matchAll(SNAPSHOT_HEADER)) {
			if (SCHEME.test(m[1])) continue;
			const abs = toAbs(m[1], cwd);
			const tag = m[2].toUpperCase();
			this.tags.set(tag, (this.tags.get(tag) ?? new Set<string>()).add(abs));

			if (focused) this.remember(abs);
		}
	}

	gitTop(dir: string): string | undefined {
		const existing = nearestExisting(dir);
		const start = isDir(existing) ? existing : dirname(existing);

		return cachedGit(this.#top, start, ["rev-parse", "--show-toplevel"], out => out.trim() || null);
	}

	/** The shared git directory: equal for every worktree of one repository. */
	repoOf(root: string): string | undefined {
		return cachedGit(this.#common, root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], out => out.trim() || null);
	}

	worktrees(root: string): string[] {
		const list = cachedGit(this.#worktrees, root, ["worktree", "list", "--porcelain"], out =>
			out
				.split("\n")
				.filter(l => l.startsWith("worktree "))
				.map(l => l.slice(9))
				.filter(isDir),
		);

		return list ?? [];
	}

	files(root: string): string[] {
		const list = cachedGit(this.#files, root, ["ls-files", "-z"], out => {
			const all = out.split("\0").filter(Boolean);

			return all.length <= MAX_LS_FILES ? all : null;
		});

		return list ?? [];
	}

	/** Roots in trust order: roots of recently used files, the cwd repo, configured companion roots. */
	roots(cwd: string): string[] {
		const out: string[] = [];

		const add = (r: string | undefined) => {
			if (r && !out.includes(r)) out.push(r);
		};

		for (let i = this.recent.length - 1; i >= Math.max(0, this.recent.length - RECENT_ROOTS); i--) {
			add(this.gitTop(dirname(this.recent[i])));
		}

		add(this.gitTop(cwd));

		for (const r of this.#configRoots) add(this.gitTop(r) ?? r);

		return out;
	}

	/** The root an absolute path was written against, and the path below it. */
	anchor(raw: string, roots: string[]) {
		const e = expandHome(raw);

		if (!isAbsolute(e)) return { root: undefined, tail: normalize(e).replace(/^(\.\/)+/, "") };
		const abs = realOf(normalize(e));
		const all = [...roots, ...roots.flatMap(r => this.worktrees(r))];

		const root =
			all.filter(r => within(r, abs)).sort((a, b) => b.length - a.length)[0] ?? this.gitTop(nearestExisting(abs));

		if (!root || !within(root, abs) || root === abs) return undefined;

		return { root, tail: relative(root, abs) };
	}

	/** Existing `<root>/<tail>` paths: trusted roots first, then the roots' other worktrees. */
	relocations(raw: string, cwd: string) {
		const roots = this.roots(cwd);
		const at = this.anchor(raw, roots);

		if (!at || at.tail.startsWith("..")) return { root: undefined, tail: "", trusted: [], others: [] };
		const trusted = roots.map(r => join(r, at.tail)).filter(existsSync);

		const others = roots
			.flatMap(r => this.worktrees(r))
			.map(r => join(r, at.tail))
			.filter(p => !trusted.includes(p) && existsSync(p));

		return { root: at.root, tail: at.tail, trusted, others: [...new Set(others)] };
	}

	/** Fix one misspelled directory segment when the rest of the path then exists. */
	segmentRepairs(abs: string): string[] {
		const parent = nearestExisting(abs);

		if (parent === abs || !isDir(parent)) return [];
		const rest = relative(parent, abs).split(sep);

		if (rest.length < 2) return [];
		const [missing, ...tailParts] = rest;

		return listDir(parent)
			// A typo is at most two edits; a renamed or truncated directory is a different place.
			.filter(name => editDistance(name, missing) <= MAX_TYPO_EDITS)
			.map(name => join(parent, name, ...tailParts))
			.filter(existsSync);
	}

	/** Closest real paths for a missing path, best first. */
	suggest(raw: string, cwd: string): string[] {
		const abs = toAbs(raw, cwd);
		const name = basename(abs);
		const out: string[] = [];

		const add = (p: string) => {
			if (!out.includes(p) && p !== abs) out.push(p);
		};

		const { trusted, others } = this.relocations(raw, cwd);
		[...trusted, ...others.slice(0, 3)].forEach(add);
		this.segmentRepairs(abs).forEach(add);

		for (const p of [...this.recent].reverse()) if (basename(p) === name) add(p);
		const parent = nearestExisting(abs);
		const missingSeg = relative(parent, abs).split(sep)[0];

		if (missingSeg && isDir(parent)) {
			listDir(parent)
				.map(n => ({ n, s: similarity(n, missingSeg) }))
				.filter(x => x.s >= 0.45)
				.sort((a, b) => b.s - a.s)
				.slice(0, 4)
				.forEach(x => add(join(parent, x.n)));
		}

		const root = this.gitTop(parent);

		if (root && out.length < MAX_SUGGESTIONS) {
			const want = relative(root, realOf(abs));
			this.files(root)
				.filter(f => basename(f) === name || similarity(basename(f), name) >= 0.7)
				.map(f => ({ f, s: similarity(f, want) + (basename(f) === name ? 0.5 : 0) }))
				.sort((a, b) => b.s - a.s)
				.slice(0, 4)
				.forEach(x => add(join(root, x.f)));
		}

		return out.slice(0, MAX_SUGGESTIONS);
	}

	/** A provable replacement for a missing read/grep/glob/find path, or undefined. */
	resolve(raw: string, cwd: string): Resolution | undefined {
		const abs = toAbs(raw, cwd);

		if (existsSync(abs)) return undefined;
		const e = expandHome(raw);

		if (!isAbsolute(e)) {
			// Leave a unique in-repo suffix to the read tool's own suffix match.
			const root = this.gitTop(cwd);
			const t = normalize(e);

			if (root && this.files(root).some(f => f === t || f.endsWith(`/${t}`))) return undefined;
		}

		const { root, tail, trusted } = this.relocations(raw, cwd);
		// A relative path was written against the cwd repository; its other worktrees are other branches.
		const baseRepo = this.repoOf(root ?? this.gitTop(cwd) ?? cwd);
		const repos = trusted.map(p => this.repoOf(this.gitTop(p) ?? p));
		// Every repository must be known: an unanswered or non-git lookup proves nothing.
		const known = baseRepo !== undefined && repos.every(r => r !== undefined);
		const elsewhere = trusted.filter((_, i) => repos[i] !== baseRepo);
		const otherRepos = new Set(repos.filter(r => r !== baseRepo));

		// A bare file name (AGENTS.md, README.md) means a different file in every repository.
		// Rewrite only when one other repository has the path; its most recently used root wins.
		if (known && tail.includes(sep) && otherRepos.size === 1) {
			return { path: elsewhere[0], why: `same path under ${this.gitTop(elsewhere[0]) ?? "a known root"}` };
		}

		const fixed = this.segmentRepairs(abs);

		if (fixed.length === 1) return { path: fixed[0], why: "one misspelled directory name corrected" };

		return undefined;
	}

	/** Rewrite edit headers whose path is missing but whose snapshot tag proves the file. */
	resolveEdit(patch: string, cwd: string) {
		const changes: Array<[string, string]> = [];

		const out = patch.replace(EDIT_HEADER, (line, p: string, tag: string) => {
			if (SCHEME.test(p) || existsSync(toAbs(p, cwd))) return line;
			const want = normalize(expandHome(p)).replace(/^(\.\/)+/, "");

			// The tag names files this session saw. Identical copies share a tag, so only a single
			// existing file with that tag and this file name is proof.
			const matches = [...(this.tags.get(tag.toUpperCase()) ?? [])].filter(
				f => basename(f) === basename(want) && existsSync(f),
			);

			const hit = matches.length === 1 ? matches[0] : undefined;

			if (!hit) return line;
			changes.push([p, hit]);

			return `[${hit}#${tag}]`;
		});

		return { patch: out, changes };
	}
}

function splitSelector(raw: string, cwd: string) {
	if (existsSync(toAbs(raw, cwd))) return { base: raw, sel: "" };
	const m = READ_SELECTOR.exec(raw);

	return m ? { base: m[1], sel: m[2] } : { base: raw, sel: "" };
}

function formatSuggestions(missing: string, list: string[]): string {
	if (list.length === 0) {
		return `[path-guard] '${missing}' does not exist and no close match was found. List the parent directory before the next call.`;
	}

	return [
		`[path-guard] '${missing}' does not exist. Closest real paths:`,
		...list.map(p => `- ${p}`),
		"Use one of these exact paths; do not guess another.",
	].join("\n");
}

/** Literal search words for a find call: its grep_keywords first, then the longer query words. */
export function findKeywords(query: string, extra: string[]): string[] {
	const words = (query.toLowerCase().match(QUERY_WORD) ?? []).filter(w => !STOPWORDS.has(w));

	const given = extra.flatMap(k => (k.trim().length >= 3 ? [k.trim()] : []));

	return [...new Set([...given, ...words])].slice(0, MAX_KEYWORDS);
}

/** A search's stdout; `null` when the program is not installed, undefined when it gave no usable answer. */
function stdoutOf(cmd: string, args: string[]): string | null | undefined {
	try {
		const r = spawnSync(cmd, args, { encoding: "utf8", timeout: FALLBACK_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });

		if (r.error && "code" in r.error && r.error.code === "ENOENT") return null;

		if (r.error || r.signal) return undefined;

		// Exit 1 is "no match"; exit 2 is an error, and a partial ranking would mislead.
		return (r.status ?? 2) > 1 ? undefined : r.stdout;
	} catch {
		return undefined;
	}
}

/** rg, or grep only where rg is not installed: a grep after an rg timeout would only be slower. */
function search(rgArgs: string[], grepArgs: string[]): string | undefined {
	const rg = stdoutOf("rg", rgArgs);

	return (rg === null ? stdoutOf("grep", grepArgs) : rg) ?? undefined;
}

/**
 * Files under `root` ranked by case-insensitive literal matches of `keywords`, or undefined when
 * the search gave no answer inside the budget (a killed search proves nothing).
 */
export function lexicalMatches(root: string, keywords: string[]): { path: string; hits: number }[] | undefined {
	const patterns = keywords.flatMap(k => ["-e", k]);

	const out = search(
		["--count-matches", "--with-filename", "-i", "-F", "--no-messages", "--max-filesize", "4M", ...patterns, "--", root],
		["-rIciH", "-F", ...patterns, "--", root],
	);

	if (out === undefined) return undefined;

	return out
		.split("\n")
		.flatMap(line => {
			const cut = line.lastIndexOf(":");
			const hits = Number(line.slice(cut + 1));

			return cut > 0 && hits > 0 ? [{ path: line.slice(0, cut), hits }] : [];
		})
		.sort((a, b) => b.hits - a.hits || a.path.localeCompare(b.path))
		.slice(0, MAX_FALLBACK_FILES);
}

/** The first matching lines of one file, as `L<n>: text`; undefined when the search gave no answer. */
export function lexicalLines(file: string, keywords: string[]): string[] | undefined {
	const patterns = keywords.flatMap(k => ["-e", k]);
	const max = String(MAX_FALLBACK_FILES);
	const out = search(["-n", "-i", "-F", "--no-messages", "--max-count", max, ...patterns, "--", file], ["-n", "-i", "-F", "-m", max, ...patterns, "--", file]);

	return out?.split("\n").flatMap(line => {
		const cut = line.indexOf(":");

		return cut > 0 ? [`L${line.slice(0, cut)}: ${line.slice(cut + 1).trim().slice(0, 160)}`] : [];
	});
}

/** `entries` are ranked files for a directory scope, or matching lines for a file scope. */
function formatFallback(root: string, keywords: string[], entries: string[], isFile: boolean): string {
	const words = keywords.map(k => `'${k}'`).join(", ");
	const where = isFile ? `'${root}'` : `any file under '${root}'`;

	if (entries.length === 0) {
		return `[path-guard] find timed out, and ${where} contains none of ${words}. Use grep with another literal or a narrower path; do not repeat the same find.`;
	}

	return [
		isFile
			? `[path-guard] find timed out before its judge finished. Lines of '${root}' with ${words}:`
			: `[path-guard] find timed out before its judge finished. Files under '${root}' with the most literal matches of ${words}:`,
		...entries.map(e => `- ${e}`),
		"Read or grep these next. They match the words, not the meaning; do not repeat the same find.",
	].join("\n");
}

/** The real owner for each `joshuawarren/<repo>` GitHub slug in a command. */
export function ownerTypoHints(command: string): string[] {
	const repos = new Set([...command.matchAll(OWNER_TYPO)].map(m => m[1]));

	return [...repos].map(
		repo =>
			`[path-guard] 'joshuawarren/${repo}' names the wrong GitHub owner. This fleet's repositories live under 'joshuaswarren' (with an s): use 'joshuaswarren/${repo}'. A GitHub 404 for that slug is the typo, not a GitHub outage.`,
	);
}

/** The REST (`gh api`) form of a GraphQL-backed `gh pr` command; REST has a separate budget. */
export function restFallback(command: string): string | undefined {
	const sub = GH_PR.exec(command)?.[1];

	if (!sub) return undefined;
	const repo = `repos/${GH_REPO_FLAG.exec(command)?.[1] ?? "{owner}/{repo}"}`;
	const pr = `${repo}/pulls/${GH_PR_NUMBER.exec(command)?.[1] ?? "<number>"}`;

	switch (sub) {
		case "checks":
			return `gh api ${repo}/commits/$(gh api ${pr} --jq .head.sha)/check-runs --jq '.check_runs[] | [.name, .status, .conclusion] | @tsv'`;
		case "view":
			return `gh api ${pr}`;
		case "merge": {
			const method = /--squash|-s\b/.test(command) ? "squash" : /--rebase|-r\b/.test(command) ? "rebase" : "merge";

			return `gh api -X PUT ${pr}/merge -f merge_method=${method} -f sha=<full head SHA from gh api ${pr} --jq .head.sha>`;
		}

		default:
			return `gh api '${repo}/pulls?state=open&per_page=50' --jq '.[] | [.number, .head.ref, .title] | @tsv'`;
	}
}

/**
 * Each 40-hex SHA in `command` that is no commit of the repository at `cwd` although its first 8 to 12
 * characters name a different commit there: a known short SHA completed with invented characters.
 * Pairs of [invented, real]. A SHA whose prefix is unknown locally (a remote-only commit) is left alone.
 */
export function inventedShas(command: string, cwd: string): [string, string][] {
	if (NOTE_COMMAND.test(command)) return [];
	const found: [string, string][] = [];

	for (const sha of new Set(command.match(FULL_SHA) ?? [])) {
		const self = git(["rev-parse", "--verify", "--quiet", `${sha}^{commit}`], cwd);

		if (!self.answered || self.out !== undefined) continue;

		for (const n of SHA_PREFIXES) {
			const r = git(["rev-parse", "--verify", "--quiet", `${sha.slice(0, n)}^{commit}`], cwd);

			if (!r.answered) break;
			const real = r.out?.trim();

			if (real) {
				if (real !== sha) found.push([sha, real]);

				break;
			}
		}
	}

	return found;
}

/**
 * Each `<home parent>/<name>` in `text` whose whole component is one or two edits from the user name
 * and does not exist (`/home/jososhuawarren` for `/home/joshuawarren`): no file can live there.
 */
export function homeTypos(text: string, home = homedir()): string[] {
	const parent = dirname(home);
	const user = basename(home);

	if (parent === "/" || text === "") return [];
	const escaped = parent.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
	const names = [...text.matchAll(new RegExp(`(?<![\\w.~-])${escaped}/([^/\\s'"\`;|&()<>:]+)`, "g"))].map(m => m[1]);

	return [
		...new Set(
			names.flatMap(name =>
				name === user || editDistance(name, user) > MAX_HOME_EDITS || existsSync(join(parent, name)) ? [] : [join(parent, name)],
			),
		),
	];
}

interface ShellRun {
	text: string;
	/** False for quoted text, heredoc bodies and comments: data, not a path the command opens. */
	code: boolean;
}

/** `command` cut into unquoted code and quoted/heredoc/comment data; joining the runs gives it back. */
export function shellRuns(command: string): ShellRun[] {
	const runs: ShellRun[] = [];
	let start = 0;
	let quote = "";

	const cut = (end: number, code: boolean) => {
		if (end > start) runs.push({ text: command.slice(start, end), code });
		start = end;
	};

	for (let i = 0; i < command.length; i++) {
		const c = command[i];

		if (quote !== "") {
			if (c === "\\" && quote === '"') i++;
			else if (c === quote) {
				cut(i + 1, false);
				quote = "";
			}

			continue;
		}

		if (c === "\\") i++;
		else if (c === "'" || c === '"') {
			cut(i, true);
			quote = c;
		} else if (command.startsWith("<<", i) || (c === "#" && (i === 0 || /\s/.test(command[i - 1])))) {
			cut(i, true);
			cut(command.length, false);

			return runs;
		}
	}

	cut(command.length, quote === "");

	return runs;
}

/**
 * Home typos in the unquoted part of a local command. Quoted text may be data (an agent-note about the
 * typo), and a remote command's paths belong to another machine, so neither counts.
 */
export function commandHomeTypos(command: string, home = homedir()): string[] {
	if (REMOTE_COMMAND.test(command)) return [];

	return [...new Set(shellRuns(command).flatMap(r => (r.code ? homeTypos(r.text, home) : [])))];
}

/**
 * A bash command that reads the asked-for part of a remote file the ssh:// reader refused as too large.
 * ssh hands its arguments to the remote shell, so a path or host with any shell syntax gets no command.
 */
export function remoteReadCommand(url: string, error: string): string | undefined {
	const file = SSH_CAP.exec(error)?.[1];
	const parts = SSH_URL.exec(url);

	if (!file || !parts || !SHELL_SAFE.test(file) || !SHELL_SAFE.test(parts[1])) return undefined;
	const [, host, sel] = parts;

	if (sel?.startsWith("-")) return `ssh ${host} 'tail -n ${sel.slice(1)} ${file}'`;

	if (sel) return `ssh ${host} 'sed -n ${sel.replace("-", ",")}p ${file}'`;

	return `ssh ${host} 'head -n ${REMOTE_HEAD_LINES} ${file}'`;
}

export default function pathGuard(pi: Api, config?: GuardConfig): PathGuard {
	const z = pi.zod;
	const guard = new PathGuard(config ?? loadConfig(z));
	const notices = new Map<string, string[]>();

	/** Keep a notice for the result of this call; calls that never return must not grow the map forever. */
	const note = (id: string, lines: string[]) => {
		notices.set(id, lines);
		const oldest = notices.keys().next().value;

		if (notices.size > MAX_NOTICES && oldest !== undefined) notices.delete(oldest);
	};

	const PathInput = z.object({ path: z.string() }).passthrough();
	const EditInput = z.object({ input: z.string() }).passthrough();
	const BashInput = z.object({ cwd: z.string().optional(), command: z.string().optional() });
	const FindInput = z.object({ query: z.string(), grep_keywords: z.array(z.string()).optional(), path: z.string().optional() });

	/** The lexical answer to a timed-out find; a URL scope or a killed search adds nothing. */
	const findFallback = (event: ToolResultEvent, cwd: string): string[] => {
		const parsed = FindInput.safeParse(event.input);

		if (!event.isError || !parsed.success) return [];
		const scope = parsed.data.path?.trim() ? parsed.data.path : cwd;

		if (!isLocalPath(scope) || !existsSync(toAbs(scope, cwd))) return [];
		const root = toAbs(scope, cwd);
		const keywords = findKeywords(parsed.data.query, parsed.data.grep_keywords ?? []);

		if (keywords.length === 0) return [];
		const isFile = !isDir(root);
		const entries = isFile ? lexicalLines(root, keywords) : lexicalMatches(root, keywords)?.map(m => `${m.path} (${m.hits})`);

		return entries ? [formatFallback(root, keywords, entries, isFile)] : [];
	};

	/** The local path a path tool targets, without a read selector. */
	const pathOf = (event: ToolEvent, cwd: string) => {
		const parsed = PathInput.safeParse(event.input);

		if (!parsed.success || !isLocalPath(parsed.data.path)) return undefined;
		const { base, sel } = event.toolName === "read" ? splitSelector(parsed.data.path, cwd) : { base: parsed.data.path, sel: "" };

		return { input: parsed.data, base, sel };
	};

	const onEditCall = (event: ToolEvent, cwd: string) => {
		const parsed = EditInput.safeParse(event.input);

		if (!parsed.success) return undefined;
		const { patch, changes } = guard.resolveEdit(parsed.data.input, cwd);

		if (changes.length === 0) return undefined;
		note(event.toolCallId, changes.map(([from, to]) => `[path-guard] '${from}' does not exist; edited '${to}' (its snapshot tag matches).`));

		return { input: { ...parsed.data, input: patch } };
	};

	/** When this session's GraphQL refusal is recent, the gh pr call it would retry. */
	let graphqlSpentAt = Number.NEGATIVE_INFINITY;

	/**
	 * Refuse a bash command that carries a hand-completed full SHA, and name the real one; refuse a
	 * GraphQL-backed gh pr command soon after GitHub refused GraphQL, and give its REST form.
	 */
	const onBashCall = (event: ToolEvent, cwd: string): CallOutcome | undefined => {
		const parsed = BashInput.safeParse(event.input);

		if (!parsed.success || !parsed.data.command) return undefined;
		const command = parsed.data.command;
		const rest = Date.now() - graphqlSpentAt < GRAPHQL_HOLD_MS ? restFallback(command) : undefined;

		if (rest) {
			return {
				block: true,
				reason: `[path-guard] GitHub refused GraphQL in this session ${Math.round((Date.now() - graphqlSpentAt) / 60_000)} min ago, and gh pr uses GraphQL, so this call would fail the same way. REST has its own budget: ${rest}. Check the GraphQL budget with: gh api rate_limit --jq .resources.graphql`,
			};
		}

		const shas = inventedShas(command, parsed.data.cwd ? toAbs(parsed.data.cwd, cwd) : cwd);

		if (shas.length === 0) return undefined;

		return {
			block: true,
			reason: shas
				.map(
					([bad, real]) =>
						`[path-guard] '${bad}' is not a commit in this repository, but its first characters name '${real}'. A full SHA must be copied from git rev-parse or the API (.head.sha), never completed by hand. Retry with the real SHA if that is the commit you mean.`,
				)
				.join("\n"),
		};
	};

	pi.on("tool_call", (event, ctx) => {
		try {
			gitDeadline = Date.now() + HANDLER_BUDGET_MS;

			if (event.toolName === "bash") return onBashCall(event, ctx.cwd);

			if (event.toolName === "edit") return onEditCall(event, ctx.cwd);

			if (!PATH_TOOLS.has(event.toolName)) return undefined;
			const target = pathOf(event, ctx.cwd);

			if (!target || (event.toolName !== "read" && GLOB_CHARS.test(target.base))) return undefined;
			const hit = guard.resolve(target.base, ctx.cwd);

			if (!hit) return undefined;
			note(event.toolCallId, [`[path-guard] '${target.base}' does not exist; used '${hit.path}' (${hit.why}).`]);

			return { input: { ...target.input, path: hit.path + target.sel } };
		} catch {
			return undefined;
		}
	});

	/** Suggestion blocks for the missing paths behind a failed call. */
	const suggestionsFor = (event: ToolResultEvent, cwd: string, text: string): string[] => {
		if (event.toolName === "find" && FIND_TIMED_OUT.test(text.slice(0, 500))) return findFallback(event, cwd);

		if (event.toolName === "bash") {
			const parsed = BashInput.safeParse(event.input);
			const typos = parsed.success && GH_NOT_FOUND.test(text) ? ownerTypoHints(parsed.data.command ?? "") : [];

			if (GRAPHQL_LIMIT.test(text)) {
				graphqlSpentAt = Date.now();
				const rest = parsed.success ? restFallback(parsed.data.command ?? "") : undefined;

				typos.push(
					`[path-guard] GitHub's GraphQL budget is spent; it refills hourly, and gh pr commands use it, so a retry fails the same way. REST has its own budget${rest ? `: ${rest}` : " (gh api repos/{owner}/{repo}/...)"}.`,
				);
			}

			if (!event.isError) return typos;
			const bashCwd = parsed.success && parsed.data.cwd ? toAbs(parsed.data.cwd, cwd) : cwd;
			const homes = parsed.success ? [...commandHomeTypos(parsed.data.command ?? ""), ...homeTypos(parsed.data.cwd ?? "")] : [];

			const homeHints = [...new Set(homes)].map(
				t => `[path-guard] '${t}' does not exist; the home directory is '${homedir()}'. Retry with that path.`,
			);

			const missing = new Set<string>();

			for (const re of BASH_MISSING) for (const m of text.matchAll(re)) missing.add(m[1]);

			// A bare word (`python3`) is a missing program, not a script path.
			const scripts = [...missing]
				.filter(p => p.includes("/") || p.includes("."))
				.slice(0, 2)
				.flatMap(p => (existsSync(toAbs(p, bashCwd)) ? [] : [formatSuggestions(p, guard.suggest(p, bashCwd))]));

			return [...typos, ...homeHints, ...scripts];
		}

		if (event.toolName === "read" && event.isError) {
			const url = PathInput.safeParse(event.input);
			const command = url.success ? remoteReadCommand(url.data.path, text.trim()) : undefined;

			if (command) return [`[path-guard] The ssh:// reader stops at 1 MiB. Read the part you need with bash: ${command}`];
		}

		if (!event.isError || !NOT_FOUND.test(text.slice(0, 500))) return [];
		const edit = EditInput.safeParse(event.input);

		const paths =
			event.toolName === "edit"
				? edit.success
					? [...edit.data.input.matchAll(EDIT_HEADER)].map(m => m[1])
					: []
				: [pathOf(event, cwd)?.base ?? ""];

		const globTool = event.toolName !== "read" && event.toolName !== "edit";

		return paths
			.slice(0, 2)
			.filter(p => p !== "" && !SCHEME.test(p) && !(globTool && GLOB_CHARS.test(p)) && !existsSync(toAbs(p, cwd)))
			.map(p => formatSuggestions(p, guard.suggest(p, cwd)));
	};

	pi.on("tool_result", (event, ctx) => {
		try {
			gitDeadline = Date.now() + HANDLER_BUDGET_MS;
			const notice = notices.get(event.toolCallId);
			notices.delete(event.toolCallId);
			const tracked = event.toolName === "bash" || event.toolName === "edit" || PATH_TOOLS.has(event.toolName);

			if (!tracked) return undefined;
			const text = event.content.map(b => b.text ?? "").join("\n");

			if (!event.isError && event.toolName !== "bash") {
				if (event.toolName !== "glob" && event.toolName !== "find") {
					guard.rememberSnapshots(text, ctx.cwd, event.toolName !== "grep");
				}

				const target = event.toolName === "read" ? pathOf(event, ctx.cwd) : undefined;

				if (target && existsSync(toAbs(target.base, ctx.cwd))) guard.remember(toAbs(target.base, ctx.cwd));
			}

			const extra = suggestionsFor(event, ctx.cwd, text);

			if (!notice && extra.length === 0) return undefined;
			const content = [...event.content];

			if (notice) content.unshift({ type: "text", text: notice.join("\n") });

			for (const t of extra) content.push({ type: "text", text: t });

			return { content };
		} catch {
			return undefined;
		}
	});

	return guard;
}
