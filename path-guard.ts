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
//   3. does the same for bash commands that fail to open a script file.
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

export interface CallOutcome {
	input: object;
}

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
	const BashInput = z.object({ cwd: z.string().optional() });

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

	pi.on("tool_call", (event, ctx) => {
		try {
			gitDeadline = Date.now() + HANDLER_BUDGET_MS;

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
		if (event.toolName === "bash") {
			if (!event.isError) return [];
			const parsed = BashInput.safeParse(event.input);
			const bashCwd = parsed.success && parsed.data.cwd ? toAbs(parsed.data.cwd, cwd) : cwd;
			const missing = new Set<string>();

			for (const re of BASH_MISSING) for (const m of text.matchAll(re)) missing.add(m[1]);

			// A bare word (`python3`) is a missing program, not a script path.
			return [...missing]
				.filter(p => p.includes("/") || p.includes("."))
				.slice(0, 2)
				.flatMap(p => (existsSync(toAbs(p, bashCwd)) ? [] : [formatSuggestions(p, guard.suggest(p, bashCwd))]));
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
