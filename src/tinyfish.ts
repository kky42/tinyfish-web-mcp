/**
 * TinyFish REST client and result formatting, independent of MCP.
 *
 * web_fetch always requests markdown, one request per call. TinyFish's
 * markdown serializer escapes markdown-special characters in structured
 * payloads (e.g. JSON key `node_id` → `node\_id`); rather than re-fetching in
 * another format, the tool description sends callers to a plain HTTP client
 * when they need exact bytes.
 */

import {
	type OutlineEntry,
	OUTLINE_BUDGET,
	PageStore,
	extractHeadings,
	fitOutline,
	formatOutlineEntry,
	linesInWindow,
	shareBudget,
	utf8,
	wrapLongLines,
} from "./pagefile.js";

const SEARCH_BASE = "https://api.search.tinyfish.ai";
const FETCH_BASE = "https://api.fetch.tinyfish.ai";

/** Characters returned inline per URL; longer pages are saved to a temp file. */
export const FETCH_WINDOW = 20_000;

/**
 * UTF-8 bytes of the whole web_fetch text per call, shared across its URLs.
 * Clients cap MCP output and cut the rest (pi at 20 KiB, from the middle;
 * Claude Code at ~25k tokens, from the tail), which can drop a later page's
 * file path; a page that doesn't fit its share is saved to a file like any
 * long page. Bytes, not characters, so CJK pages (3 bytes per char) fit too.
 */
export const CALL_BUDGET = 19 * 1024;

/** Bytes set aside per page for the truncation note (it includes a long temp path). */
const NOTE_RESERVE = 400;

export type DomainType = "web" | "news" | "research_paper";

export const RECENCY_MINUTES = { hour: 60, day: 1440, week: 10_080, month: 43_200, year: 525_600 } as const;
export type Recency = keyof typeof RECENCY_MINUTES;

export interface SearchParams {
	query: string;
	domain_type?: DomainType;
	recency?: Recency;
	include_domains?: string[];
	exclude_domains?: string[];
}

export interface SearchResult {
	site_name?: string;
	title?: string;
	snippet?: string;
	url?: string;
	date?: string;
	publisher?: string;
	authors?: string[];
	venue?: string;
	year?: number;
	cited_by_count?: number;
	pdf_url?: string;
}

interface FetchResult {
	url: string;
	final_url?: string;
	title?: string;
	description?: string | null;
	text?: string | null;
}

interface FetchResponse {
	results?: FetchResult[];
	errors?: { url: string; error: string }[];
}

function requireApiKey(): string {
	const key = process.env.TINYFISH_API_KEY;
	if (!key) {
		throw new Error("TINYFISH_API_KEY is not set. Pass it in the MCP server's environment.");
	}
	return key;
}

async function errorFromResponse(res: Response): Promise<string> {
	let body = "";
	try {
		body = (await res.text()).slice(0, 500);
	} catch {
		/* ignore */
	}
	// TinyFish errors are {"error": {"code", "message"}}; keep just the message.
	try {
		const message = (JSON.parse(body) as { error?: { message?: string } }).error?.message;
		if (message) body = message;
	} catch {
		/* not JSON: keep the raw body */
	}
	return `HTTP ${res.status}${body ? `: ${body}` : ""}`;
}

export interface SearchOutput {
	text: string;
	data: {
		query: string;
		total_results: number;
		results: SearchResult[];
	};
}

export async function search(params: SearchParams, signal?: AbortSignal): Promise<SearchOutput> {
	const key = requireApiKey();
	// TinyFish takes domain lists as comma-separated strings and recency in minutes.
	const sp = new URLSearchParams({ query: params.query });
	if (params.domain_type) sp.set("domain_type", params.domain_type);
	if (params.recency) sp.set("recency_minutes", String(RECENCY_MINUTES[params.recency]));
	if (params.include_domains?.length) sp.set("include_domains", params.include_domains.join(","));
	if (params.exclude_domains?.length) sp.set("exclude_domains", params.exclude_domains.join(","));

	const res = await fetch(`${SEARCH_BASE}?${sp}`, { headers: { "X-API-Key": key }, signal });
	if (!res.ok) throw new Error(`TinyFish search failed: ${await errorFromResponse(res)}`);

	const data = (await res.json()) as { results?: SearchResult[]; total_results?: number };
	const results = data.results ?? [];
	const lines = [`[web_search] "${params.query}" — ${data.total_results ?? results.length} results`];
	if (results.length === 0) lines.push("(no results)");
	results.forEach((r, i) => lines.push(...formatSearchResult(r, params.domain_type, i + 1)));
	return {
		text: lines.join("\n"),
		data: { query: params.query, total_results: data.total_results ?? results.length, results },
	};
}

function formatSearchResult(r: SearchResult, domainType: DomainType | undefined, index: number): string[] {
	const lines = [`${index}. ${r.title ?? r.url ?? "(untitled)"}`];
	if (r.site_name) lines.push(`   site: ${r.site_name}`);
	if (r.url) lines.push(`   ${r.url}`);
	if (domainType === "news") {
		if (r.publisher) lines.push(`   publisher: ${r.publisher}`);
		if (r.date) lines.push(`   date: ${r.date}`);
	}
	if (domainType === "research_paper") {
		if (r.authors?.length) lines.push(`   authors: ${r.authors.join(", ")}`);
		if (r.venue) lines.push(`   venue: ${r.venue}`);
		if (r.year !== undefined) lines.push(`   year: ${r.year}`);
		if (r.cited_by_count !== undefined) lines.push(`   cited_by: ${r.cited_by_count}`);
		if (r.pdf_url) lines.push(`   pdf: ${r.pdf_url}`);
	}
	if (r.snippet) lines.push(`   ${r.snippet}`);
	return lines;
}

export interface FetchedPage {
	url: string;
	final_url?: string;
	title?: string;
	description?: string;
	/** The page as markdown, or for a truncated page its first `shown_lines` lines. */
	text: string;
	total_chars: number;
	/** Set only when the page didn't fit in one window. */
	truncated?: {
		shown_lines: number;
		total_lines: number;
		/** Temp file with the full markdown; absent if saving failed (see `save_error`). */
		path?: string;
		save_error?: string;
		outline: OutlineEntry[];
		omitted_headings: number;
	};
}

export interface FetchOutput {
	text: string;
	data: { pages: FetchedPage[]; errors: { url: string; error: string }[] };
}

const store = new PageStore();

export async function fetchPages(urls: string[], signal?: AbortSignal): Promise<FetchOutput> {
	const key = requireApiKey();
	const res = await fetch(FETCH_BASE, {
		method: "POST",
		headers: { "X-API-Key": key, "Content-Type": "application/json" },
		body: JSON.stringify({ urls, format: "markdown" }),
		signal,
	});
	if (!res.ok) throw new Error(`TinyFish fetch failed: ${await errorFromResponse(res)}`);

	const data = (await res.json()) as FetchResponse;
	const lines: string[] = [];
	const pages: FetchedPage[] = [];
	const saved = new Set<string>();
	const results = data.results ?? [];
	const errors = data.errors ?? [];
	const errorLines = errors.map((e) => `✗ ${e.url} — ${e.error}`);
	const meta = results.map((r) => {
		// Lead with the requested URL so multi-URL results map back to their
		// inputs; surface redirects since relative links resolve against final_url.
		const head = [`— ${r.url}`];
		if (r.final_url && r.final_url !== r.url) head.push(`  redirected to: ${r.final_url}`);
		if (r.title) head.push(`  title: ${r.title}`);
		if (r.description) head.push(`  ${r.description}`);
		return head;
	});
	// Page text and outlines get what the URLs, titles, notes and errors leave over.
	const fixed = [...meta.flat(), ...errorLines].reduce((n, l) => n + utf8(l) + 1, 0);
	const available = Math.max(0, CALL_BUDGET - fixed - NOTE_RESERVE * results.length);
	// A page that fits needs its own size; a long one, a full window plus outline.
	const needs = results.map(({ text }) => {
		const page = text ?? "";
		return page.length <= FETCH_WINDOW ? utf8(page) : utf8(page.slice(0, FETCH_WINDOW)) + OUTLINE_BUDGET;
	});
	const shares = shareBudget(needs, available);
	for (const [i, r] of results.entries()) {
		const page = r.text ?? "";
		const fits = page.length <= FETCH_WINDOW && utf8(page) <= shares[i];
		const truncated = fits ? undefined : await saveLongPage(r.url, page, shares[i]);
		if (truncated?.info.path) saved.add(truncated.info.path);
		const text = truncated ? truncated.text : page;

		lines.push(...meta[i]);
		// The note and outline go before the text, not after, so a client that
		// cuts the tail of the output still shows where the full page is.
		if (truncated) lines.push(...truncated.header);
		lines.push(text, "");

		pages.push({
			url: r.url,
			...(r.final_url && r.final_url !== r.url && { final_url: r.final_url }),
			...(r.title && { title: r.title }),
			...(r.description && { description: r.description }),
			text,
			total_chars: page.length,
			...(truncated && { truncated: truncated.info }),
		});
	}
	// Clean up on every call, not only after a save, so old files expire even
	// when no long page is fetched again. A missing directory is a no-op.
	await store.collectGarbage(saved).catch(() => {});
	lines.push(...errorLines);
	if (lines.length === 0) lines.push("(no content returned)");
	return { text: lines.join("\n"), data: { pages, errors } };
}

/**
 * Save a page that doesn't fit inline to a temp file and describe it: the
 * first lines that fit `share` bytes (and one window), plus a header note with
 * the file path and a heading outline so the agent can Read or Grep just the
 * part it needs. Line numbers refer to the saved file, whose long lines are
 * wrapped.
 */
async function saveLongPage(
	url: string,
	page: string,
	share: number,
): Promise<{ text: string; header: string[]; info: NonNullable<FetchedPage["truncated"]> }> {
	const fileLines = wrapLongLines(page);
	// Up to a fifth of the share goes to the outline, the rest to text.
	const { entries, omitted } = fitOutline(
		extractHeadings(fileLines),
		Math.min(OUTLINE_BUDGET, Math.floor(share / 5)),
		utf8,
	);
	const outlineBytes = entries.reduce((n, e) => n + utf8(formatOutlineEntry(e)) + 1, 0);
	const shown = Math.min(
		linesInWindow(fileLines, FETCH_WINDOW),
		linesInWindow(fileLines, share - outlineBytes, utf8),
	);

	let path: string | undefined;
	let saveError: string | undefined;
	try {
		path = await store.save(url, fileLines.join("\n"));
	} catch (err) {
		saveError = err instanceof Error ? err.message : String(err);
	}

	const total = `${fileLines.length} lines (${page.length} chars)`;
	const size = shown > 0 ? `showing lines 1–${shown} of ${total}` : `no inline text; page is ${total}`;
	const header = path
		? [`  [truncated: ${size}. Full markdown saved to ${path} — Grep it or Read a line range for the rest]`]
		: [`  [truncated: ${size}. Could not save the full page: ${saveError}]`];
	if (entries.length > 0) {
		header.push("  Outline (line: heading):", ...entries.map((e) => `    ${formatOutlineEntry(e)}`));
		if (omitted > 0) header.push(`    (${omitted} more headings — grep for '^#' in the file)`);
	}
	return {
		text: fileLines.slice(0, shown).join("\n"),
		header,
		info: {
			shown_lines: shown,
			total_lines: fileLines.length,
			...(path ? { path } : { save_error: saveError }),
			outline: entries,
			omitted_headings: omitted,
		},
	};
}
