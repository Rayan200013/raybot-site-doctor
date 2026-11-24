# raybot-site-doctor

An MCP server that checks a website the way a visitor and a search engine see it, and says what to fix first: search and sitemaps, structured data, speed, accessibility, phone fit and page errors.

It runs on your own computer, started by Claude Code, Claude's desktop app or your editor. It needs no API key and no account, and **it sends nothing anywhere**: no telemetry, no error reports, no usage counts. The only requests it makes are to the site you ask it to check.

## Add it to Claude Code

```sh
# Node 22.12 or later; Chrome or Edge for the four browser checks
claude mcp add --transport stdio --scope user site-doctor -- npx -y raybot-site-doctor
# then ask Claude: "Check https://example.com and tell me what to fix first."
```

Or run the whole checkup as a command: `/mcp__site-doctor__checkup https://example.com`.

## What it checks

Eight tools. The first four need only the network. The other four load the page in the Chrome or Edge already on your computer, started headless. Nothing downloads a browser.

| Tool                    | Give it                           | What it reports                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check_page`            | one address                       | The page as a search engine and a WhatsApp or Facebook preview see it: status and redirects; title and description (present, length); the H1; the canonical address (and that it answers); robots meta and `X-Robots-Tag`; `lang` and `dir`; hreflang language versions (each loads and points back); share title, description and image (it loads and is big enough); the viewport; JSON-LD types; images without `alt`; HTML size, compression, caching, server time                            |
| `check_sitemaps`        | a site                            | `robots.txt` and every sitemap it names (indexes and gzip included): rules that block the site, lines crawlers ignore, sitemaps that don't load or parse, and each listed address that errors, redirects, is disallowed, says `noindex` or names another page as canonical; `lastmod` dates that are invalid, in the future or all the same day; language alternates that disagree with the pages                                                                                                 |
| `check_site`            | a site, a page cap                | The crawl: every page the sitemaps list (or the links reach), then what only a view across pages shows: titles and descriptions duplicated within a language, broken internal links with the page they sit on, pages nothing links to (a page's own language versions don't count), hreflang that isn't returned, `noindex` pages in the sitemap, redirect chains, pages missing from the sitemaps                                                                                                |
| `check_structured_data` | one address, or `whole_site`      | JSON-LD against schema.org's own vocabulary (types and properties that don't exist or don't belong together; the vocabulary ships with the server, its version named in every answer) and Google's rules for breadcrumbs, FAQ, product and offer, article, organization, local business and event; `@id` references that point at nothing                                                                                                                                                         |
| `measure_speed`         | one address; `phone` or `desktop` | Three loads from an empty cache as a mid-range phone on slow 4G (Lighthouse's slow 4G as DevTools applies it: 562.5 ms per request, 1,475 Kbps down, the processor 4× slower), the middle one reported: first paint, largest paint and **which element** it is with its timeline, layout shift and what moved, blocking time, weight by kind, files that block the first paint, pictures far larger than drawn, text sent uncompressed. Then a PageSpeed Insights link for real visitors' numbers |
| `check_accessibility`   | one address                       | axe-core's WCAG 2.2 AA rules at phone and desktop widths, the whole page drawn first; then **contrast measured on the real pixels** for every line of text axe leaves "to review" (text over a photograph, a gradient or a video)                                                                                                                                                                                                                                                                 |
| `check_phone_fit`       | one address; sizes (optional)     | At phone sizes from 320×568 to 430×932: anything wider than the screen and which element; text cut off or drawn over other text; tap targets under 24×24 px without room around them (WCAG 2.5.8) and how many are under 44×44; text under 12 px; whether the main heading and a first button are on the first screen; fixed bars covering the screen                                                                                                                                             |
| `check_page_errors`     | one address                       | What breaks while the page loads: JavaScript errors, console errors, requests that fail or answer an error, insecure `http://` content on an `https://` page, and the other sites the page calls, with their weight                                                                                                                                                                                                                                                                               |

And one prompt, **`checkup`**, which runs them all on the home page and two other pages and asks for one report: the three things to fix first, then the rest by kind.

Every answer ranks what it found as **fix first**, **worth fixing** or **notes**, with the first examples of each and what to do, and says what passed. The same report comes back as structured data (`structuredContent`, with an `outputSchema`); Claude Code and VS Code give their model that version rather than the text, so it carries the text's closing guidance too (`reading`). To see every example of one kind, call the tool again with `kind` set to its name: for 15 minutes that re-reads the earlier check instead of checking again.

## How it behaves

- **Read only.** `GET` requests and page loads, nothing else. No tool posts, logs in, fills a form or changes anything. Each tool says so in its annotations (`readOnlyHint`), which also lets Claude Code run two of them side by side.
- **Polite.** It reads the site it was given, its `www.`/`https` twin, and the language versions the site itself names. One request at a time across the whole server, 250 ms apart by default (`delay_ms`), or slower if `robots.txt` asks with `Crawl-delay`. A page cap per crawl (200 by default, 1,000 at most), a 15-second timeout, links with a query string (filters, sorting) not followed when the site has sitemaps. It introduces itself as `raybot-site-doctor/<version> (+https://github.com/Rayan200013/raybot-site-doctor)`; in the browser checks, as Chrome with that name added.
- **`robots.txt` followed.** A page `robots.txt` disallows is reported as blocked, not read. To check a site that disallows crawling (a staging site usually does), the caller must pass `ignore_robots_txt: true`, and the report then says so on its first lines. The tools tell the assistant to use it only when you have said the site is yours or that you may test it.
- **What a page says is data.** Titles, descriptions and headings come back quoted, as values in the report, never as instructions. Since no tool can send or change anything, a page written to mislead an assistant can at worst mislead the report.
- **Answers sized for an assistant.** A summary in plain words with the first five examples of each kind, kept under Claude Code's 10,000-token warning (a whole-site crawl of 615 pages answered in about 3,100 characters).

### It sends nothing anywhere

- No telemetry, no analytics, no crash or error reporting, no update checks, no account.
- The HTTP checks make requests only to the site you name (and the share image and language versions its pages name).
- The browser checks load the page as a visitor's browser would, so the page's own files (its scripts, fonts, pictures, and any third-party tags it loads) are fetched too. The browser runs headless in a fresh temporary profile, with its background networking, crash reporting and updates switched off.
- The answers go to your MCP client and nowhere else. What your assistant does with them is between you and its provider.

## Other clients

The same server works in any MCP client that starts local servers. Checked against each app's documentation in November 2026.

**Claude's desktop app**: `claude_desktop_config.json` (on macOS in `~/Library/Application Support/Claude/`, on Windows in `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "site-doctor": { "command": "npx", "args": ["-y", "raybot-site-doctor"] }
  }
}
```

**Cursor**: `~/.cursor/mcp.json` (every project) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "site-doctor": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "raybot-site-doctor"]
    }
  }
}
```

**VS Code (GitHub Copilot agent mode)**: `.mcp.json` at the root of the workspace, or `~/.copilot/mcp-config.json` for every workspace (VS Code asks you to trust the server the first time it starts from there). Tried in VS Code 1.147 on Windows:

```json
{
  "mcpServers": {
    "site-doctor": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "raybot-site-doctor"]
    }
  }
}
```

A VS Code that doesn't read `.mcp.json` yet takes the same server in `.vscode/mcp.json`, with `"servers"` in place of `"mcpServers"`.

On Windows, if a client says it cannot start `npx`, make the command `cmd` and the arguments `["/c", "npx", "-y", "raybot-site-doctor"]`.

## Requirements

- **Node.js 22.12 or later.**
- **Google Chrome, Microsoft Edge or Chromium** for `measure_speed`, `check_accessibility`, `check_phone_fit` and `check_page_errors`. It finds Chrome or Edge where they are usually installed; for another Chromium-based browser, set `SITE_DOCTOR_BROWSER` to its path. Without one, those four say so plainly and the other four still work.

The install is small: the MCP SDK, zod, playwright-core (to drive the browser you have), axe-core and parse5, about 35 MB in all.

## Not in this version

- **Real visitors' speed** (Chrome's field data): Google's API needs a key, and this server needs none. `measure_speed` gives the PageSpeed Insights link for the same address instead.
- **A score.** `measure_speed` measures the way Lighthouse's applied throttling does, with Chrome's own timing entries, and names the element at fault; it is not Lighthouse and gives no 0–100 score.
- **Search Console** (clicks, positions): it needs the site owner's Google sign-in.
- **Fixing anything.** It says what to fix and where; your assistant can then change your own code.
- **Pages behind a sign-in**, and judging the writing itself (the assistant reads the titles and headings the tools return and can do that).
- **Microdata and RDFa**: only JSON-LD is checked.

## Develop

```sh
npm install
npm test          # unit tests, the eight tools against a site built to be wrong and its fixed copy, and stdio
npm run build     # dist/
```

The tests serve `test/fixtures/broken` (duplicate titles, a broken link, an orphan, broken JSON-LD, pale text over a photograph, a row wider than a phone…) and `test/fixtures/fixed`: every problem must be found in the first, and the second must pass. The browser tests skip themselves when no Chrome or Edge is installed.

`data/schemaorg-vocabulary.json` is made from schema.org's release file with `node scripts/vocabulary.mjs <file> <version> <date>`.

## Licence

The code is MIT licensed, copyright (c) 2026 Raybot: see [LICENSE](LICENSE). The schema.org vocabulary in `data/` is schema.org's, under CC BY-SA 3.0: see [NOTICE.md](NOTICE.md).

Made by [Raybot](https://raybot.store), a studio in Lebanon that builds web apps and MCP servers.
