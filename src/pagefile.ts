/**
 * Long pages: instead of paging through web_fetch (TinyFish has no range
 * requests, so every page window re-downloads the whole document), the full
 * markdown is saved to a temp file once and the agent reads it with its own
 * file tools. This module prepares that file and a heading outline with line
 * numbers, so the agent can jump straight to a section.
 *
 * Files live in os.tmpdir()/tinyfish-web-mcp, named by URL hash. Cleanup
 * piggybacks on every save (TTL + total size cap, oldest first), so the
 * directory stays bounded even if the server is killed.
 */

import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Lines longer than this are broken at whitespace before saving. File-reading
 * tools truncate long lines (Claude Code's Read cuts at 2,000 chars) and Grep
 * prints whole matching lines, so one-line blobs would hide or flood text.
 */
export const MAX_LINE = 1_000;

/** Characters of outline shown with a truncated page; deeper levels are dropped first. */
export const OUTLINE_BUDGET = 3_000;

/** Dropping heading levels stops before the outline gets shorter than this. */
const MIN_OUTLINE_ENTRIES = 8;

/** How a budget is counted: characters by default, UTF-8 bytes via `utf8`. */
export type Measure = (s: string) => number;
const chars: Measure = (s) => s.length;
export const utf8: Measure = (s) => Buffer.byteLength(s);

export interface OutlineEntry {
	line: number;
	level: number;
	title: string;
}

export function wrapLongLines(text: string, max = MAX_LINE): string[] {
	const out: string[] = [];
	for (const line of text.split("\n")) {
		let rest = line;
		while (rest.length > max) {
			const space = rest.lastIndexOf(" ", max);
			// No usable whitespace (e.g. a base64 blob): hard break.
			if (space < max / 2) {
				out.push(rest.slice(0, max));
				rest = rest.slice(max);
			} else {
				out.push(rest.slice(0, space));
				rest = rest.slice(space + 1);
			}
		}
		out.push(rest);
	}
	return out;
}

/** Number of leading lines that fit in `size`; 0 if even the first doesn't. */
export function linesInWindow(lines: string[], size: number, measure: Measure = chars): number {
	let used = 0;
	for (let i = 0; i < lines.length; i++) {
		used += measure(lines[i]) + (i > 0 ? 1 : 0);
		if (used > size) return i;
	}
	return lines.length;
}

/** ATX headings with 1-based line numbers, skipping fenced code blocks. */
export function extractHeadings(lines: string[]): OutlineEntry[] {
	const entries: OutlineEntry[] = [];
	let fence: string | undefined;
	lines.forEach((line, i) => {
		const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
		if (marker) {
			if (!fence) fence = marker;
			else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
			return;
		}
		if (fence) return;
		const m = line.match(/^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/);
		if (m && m[2]) entries.push({ line: i + 1, level: m[1].length, title: m[2].slice(0, 120) });
	});
	return entries;
}

export function formatOutlineEntry(e: OutlineEntry): string {
	return `${e.line}: ${"#".repeat(e.level)} ${e.title}`;
}

/**
 * Fit the outline into `budget`: drop the deepest heading levels first, but
 * not below MIN_OUTLINE_ENTRIES (a changelog's lone `# ChangeLog` is useless),
 * then cut the list. `omitted` counts headings left out.
 */
export function fitOutline(
	entries: OutlineEntry[],
	budget = OUTLINE_BUDGET,
	measure: Measure = chars,
): { entries: OutlineEntry[]; omitted: number } {
	const entrySize = (e: OutlineEntry) => measure(formatOutlineEntry(e)) + 1;
	const size = (list: OutlineEntry[]) => list.reduce((n, e) => n + entrySize(e), 0);
	let kept = entries;
	for (let level = 5; level >= 1 && size(kept) > budget; level--) {
		const shallower = entries.filter((e) => e.level <= level);
		if (shallower.length < MIN_OUTLINE_ENTRIES) break;
		kept = shallower;
	}
	if (size(kept) > budget) {
		let used = 0;
		const prefix: OutlineEntry[] = [];
		for (const e of kept) {
			used += entrySize(e);
			if (used > budget) break;
			prefix.push(e);
		}
		kept = prefix;
	}
	return { entries: kept, omitted: entries.length - kept.length };
}

/**
 * Split `budget` across requests: each gets what it needs if it can, and
 * what small requests leave over goes to the larger ones.
 */
export function shareBudget(needs: number[], budget: number): number[] {
	const shares = new Array<number>(needs.length).fill(0);
	const order = needs.map((_, i) => i).sort((a, b) => needs[a] - needs[b]);
	let remaining = budget;
	order.forEach((i, k) => {
		shares[i] = Math.min(needs[i], Math.floor(remaining / (order.length - k)));
		remaining -= shares[i];
	});
	return shares;
}

export interface PageStoreOptions {
	dir?: string;
	ttlMs?: number;
	maxBytes?: number;
}

export class PageStore {
	readonly dir: string;
	private readonly ttlMs: number;
	private readonly maxBytes: number;

	constructor({ dir, ttlMs, maxBytes }: PageStoreOptions = {}) {
		this.dir = dir ?? join(tmpdir(), "tinyfish-web-mcp");
		this.ttlMs = ttlMs ?? 24 * 60 * 60 * 1000;
		this.maxBytes = maxBytes ?? 100 * 1024 * 1024;
	}

	pathFor(url: string): string {
		return join(this.dir, `${createHash("sha256").update(url).digest("hex").slice(0, 32)}.md`);
	}

	/** Write atomically (temp file + rename) so concurrent fetches never expose a partial file. */
	async save(url: string, text: string): Promise<string> {
		await this.ensureDir();
		const path = this.pathFor(url);
		const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
		try {
			await writeFile(tmp, text, { mode: 0o600, flag: "wx" });
			await rename(tmp, path);
		} catch (err) {
			await rm(tmp, { force: true });
			throw err;
		}
		return path;
	}

	/**
	 * Delete files past the TTL, then the oldest until the directory fits the
	 * size cap. `keep` (files written by the current call) is never deleted.
	 * Races with other server instances are harmless: missing files are skipped.
	 */
	async collectGarbage(keep: Set<string> = new Set()): Promise<void> {
		let names: string[];
		try {
			names = await readdir(this.dir);
		} catch {
			return;
		}
		const now = Date.now();
		const files: { path: string; size: number; mtime: number }[] = [];
		for (const name of names) {
			const path = join(this.dir, name);
			try {
				const s = await stat(path);
				if (s.isFile()) files.push({ path, size: s.size, mtime: s.mtimeMs });
			} catch {
				/* deleted concurrently */
			}
		}
		files.sort((a, b) => b.mtime - a.mtime);
		let total = 0;
		for (const f of files) {
			if (keep.has(f.path)) {
				total += f.size;
				continue;
			}
			if (now - f.mtime > this.ttlMs || total + f.size > this.maxBytes) {
				await rm(f.path, { force: true });
			} else {
				total += f.size;
			}
		}
	}

	/**
	 * The directory may sit in a shared /tmp: refuse a symlink or a directory
	 * owned by another user, and keep it private to the current user.
	 */
	private async ensureDir(): Promise<void> {
		await mkdir(this.dir, { recursive: true, mode: 0o700 });
		const s = await lstat(this.dir);
		if (!s.isDirectory()) throw new Error(`${this.dir} is not a directory`);
		const uid = process.getuid?.();
		if (uid === undefined) return;
		if (s.uid !== uid) throw new Error(`${this.dir} is owned by another user`);
		if (s.mode & 0o077) await chmod(this.dir, 0o700);
	}
}
