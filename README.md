# tinyfish-web-mcp

A lean MCP server that gives any agent two tools, `web_search` and `web_fetch`, backed by [TinyFish](https://tinyfish.ai)'s Search and Fetch APIs. Both APIs are free at any wallet balance.

Unofficial. TinyFish also runs an [official remote MCP server](https://docs.tinyfish.ai/mcp) with around 15 tools, including paid browser automation. This server exposes only search and fetch, so it costs about 2 KB of tool schema in your agent's context.

## Tools

**`web_search`**: searches the live web and returns up to 10 ranked results (title, URL, snippet). News results add date and publisher; research papers add authors, venue and citation count.

| Input | Description |
|---|---|
| `query` (required) | Search keywords |
| `domain_type` | `web` (default), `news`, or `research_paper` |
| `recency` | `hour`, `day`, `week`, `month` or `year`: only results from that period |
| `include_domains` / `exclude_domains` | Arrays of domains to limit results to or exclude |

**`web_fetch`**: reads 1–10 URLs as clean markdown, with JavaScript rendered.

| Input | Description |
|---|---|
| `urls` (required) | URLs to read (1–10) |

One call returns at most about 19 KiB of text, so it fits under client output limits (pi cuts MCP output at 20 KiB, Claude Code at about 25k tokens) and no page's file path gets cut. A single page shows up to about 19,000 characters inline (fewer for CJK text, which takes 3 bytes per character). When several URLs share a call, short pages are returned whole and the rest split what's left. A page that doesn't fit is downloaded once and saved in full to a markdown file under `$TMPDIR/tinyfish-web-mcp/`. Its result header gives the file path and an outline of the page's headings with line numbers, so the agent can `Grep` the file or `Read` just the section it needs, with no more network calls:

```
[truncated: showing lines 1–160 of 5295 (446095 chars). Full markdown saved to /tmp/tinyfish-web-mcp/2cb5….md — Grep it or Read a line range for the rest]
Outline (line: heading):
  25: ## 1. Introduction
  1214: ## 8. Representation Data and Metadata
  …
```

The note and outline sit before the page text, so they survive clients that truncate long tool output. The outline is capped at about 3,000 characters (deeper heading levels are dropped first). Lines longer than 1,000 characters are wrapped in the saved file so file-reading tools don't cut them. Saved files are private to the current user, re-fetching a URL overwrites its file, and every `web_fetch` call deletes files older than 24 hours and the oldest files beyond 100 MB in total.

Both tools return readable text plus `structuredContent` for scripts (for example pi's codemode): `web_search` gives `results[{title, url, snippet, ...}]`, `web_fetch` gives `pages[{url, title, text, total_chars, truncated?}]` and `errors`. `truncated` is present only for long pages and holds `{path, outline[{line, level, title}], omitted_headings, shown_lines, total_lines}`. A call fails with `isError: true` when it errors, or when every URL of a `web_fetch` fails; clients that run tools from scripts get that as a normal result, so check `isError`. TinyFish returns no results for `domain_type: "news"` combined with `exclude_domains`, and rejects `recency` with `research_paper`.

Markdown conversion can alter structured data; for example, it escapes `_` in JSON keys. Fetch JSON and raw files with a plain HTTP client instead.

## Install

Create an API key at [agent.tinyfish.ai/api-keys](https://agent.tinyfish.ai/api-keys). The server reads it from `TINYFISH_API_KEY`. Requires Node.js 20 or later.

**Claude Code**

```sh
claude mcp add tinyfish-web -s user -e TINYFISH_API_KEY=sk-tinyfish-... -- npx -y @kky42/tinyfish-web-mcp
```

**Codex**

```sh
codex mcp add tinyfish-web --env TINYFISH_API_KEY=sk-tinyfish-... -- npx -y @kky42/tinyfish-web-mcp
```

**Other MCP clients** (Cursor, Claude Desktop, and others that use this JSON format)

```json
{
  "mcpServers": {
    "tinyfish-web": {
      "command": "npx",
      "args": ["-y", "@kky42/tinyfish-web-mcp"],
      "env": { "TINYFISH_API_KEY": "sk-tinyfish-..." }
    }
  }
}
```

**Pi** has built-in MCP support. Add this to `~/.pi/agent/mcp.json` and run `pi mcp list` to check it. With the default exposure the tools are reached from `codemode` scripts as `tools.mcp__tinyfish_web__web_search` and `tools.mcp__tinyfish_web__web_fetch`; add `"exposure": "direct"` to declare them to the model like built-in tools.

```json
{
  "mcpServers": {
    "tinyfish-web": {
      "command": "npx",
      "args": ["-y", "@kky42/tinyfish-web-mcp"]
    }
  }
}
```

If `TINYFISH_API_KEY` is exported in your shell, pi passes it to the server.

## Development

```sh
npm install
npm run test:e2e   # build + real MCP client over stdio against the live TinyFish APIs (needs TINYFISH_API_KEY)
```

## License

MIT
