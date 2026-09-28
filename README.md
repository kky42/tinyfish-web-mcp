# tinyfish-web-mcp

A lean MCP server that gives any agent two tools, `web_search` and `web_fetch`, backed by [TinyFish](https://tinyfish.ai)'s Search and Fetch APIs. Both APIs are free at any wallet balance.

Unofficial. TinyFish also runs an [official remote MCP server](https://docs.tinyfish.ai/mcp) with around 15 tools, including paid browser automation. This server exposes only search and fetch, so it costs about 2 KB of tool schema in your agent's context.

## Tools

**`web_search`**: searches the live web and returns up to 10 ranked results (title, URL, snippet). News results add date and publisher; research papers add authors, venue and citation count.

| Input | Description |
|---|---|
| `query` (required) | Search keywords; supports `site:` and `-site:` |
| `purpose` | One sentence on why you're searching; improves ranking |
| `domain_type` | `web` (default), `news`, or `research_paper` |
| `recency_minutes` | Only results from the last N minutes |
| `include_domains` / `exclude_domains` | Comma-separated domain filters |

**`web_fetch`**: reads 1–10 URLs as clean markdown, with JavaScript rendered.

| Input | Description |
|---|---|
| `urls` (required) | URLs to read (1–10) |
| `offset` | Character position to start from, applied to every URL (default 0) |

Each URL returns at most 20,000 characters. For a longer page, the result header names the exact follow-up call, for example `offset 20000`, so the agent reads the next part instead of starting over. The note sits before the page text, so it survives clients that truncate long tool output. Every call downloads the whole page again, because TinyFish has no range requests.

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

**Pi**, via [pi-mcp-adapter](https://www.npmjs.com/package/pi-mcp-adapter). Run `pi install npm:pi-mcp-adapter`, then add this to `~/.pi/agent/mcp-adapter.json`. `directTools` and `toolPrefix: "none"` make the tools appear as plain `web_search` and `web_fetch`:

```json
{
  "mcpServers": {
    "tinyfish-web": {
      "command": "npx",
      "args": ["-y", "@kky42/tinyfish-web-mcp"],
      "directTools": true,
      "toolPrefix": "none"
    }
  }
}
```

If `TINYFISH_API_KEY` is exported in your shell, pi passes it to the server.

## Development

```sh
npm install
npm test           # build + unit tests
npm run test:e2e   # build + real MCP client over stdio against the live TinyFish APIs (needs TINYFISH_API_KEY)
```

## License

MIT
