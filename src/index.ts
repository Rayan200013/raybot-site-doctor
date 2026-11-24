#!/usr/bin/env node
// Starts the server on stdin/stdout, as Claude Code, Claude's desktop app and
// code editors start a local MCP server. Nothing is written anywhere but the
// answers; notes for a person go to stderr.
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createServer } from './server.ts';
import { closeBrowser } from './core/browser.ts';
import { NAME, VERSION, REPOSITORY } from './version.ts';

const arg = process.argv[2];
if (arg === '--version' || arg === '-v') {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}
if (arg === '--help' || arg === '-h') {
  process.stdout.write(
    [
      `${NAME} ${VERSION}: an MCP server that checks a website and says what to fix first.`,
      '',
      'It is started by an MCP client (Claude Code, Claude Desktop, Cursor, VS Code), not by hand:',
      `  claude mcp add --transport stdio --scope user site-doctor -- npx -y ${NAME}`,
      '',
      'Environment:',
      '  SITE_DOCTOR_BROWSER   path to a Chromium-based browser, when Chrome or Edge is not found',
      '',
      REPOSITORY,
      '',
    ].join('\n'),
  );
  process.exit(0);
}

const server = createServer();
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`${NAME} ${VERSION} ready (stdio)\n`);

const stop = async () => {
  await closeBrowser();
  await server.close().catch(() => undefined);
  process.exit(0);
};
process.stdin.on('close', () => void stop());
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
