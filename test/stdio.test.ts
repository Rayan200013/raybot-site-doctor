// The server as a client starts it: a child process speaking MCP on stdio.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const entry = process.env['SD_ENTRY'] ?? fileURLToPath(new URL('../src/index.ts', import.meta.url));

test('lists eight read-only tools and the checkup prompt over stdio', async () => {
  const client = new Client({ name: 'stdio-test', version: '0' });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [entry], stderr: 'ignore' }),
  );
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      'check_accessibility',
      'check_page',
      'check_page_errors',
      'check_phone_fit',
      'check_site',
      'check_sitemaps',
      'check_structured_data',
      'measure_speed',
    ]);
    for (const t of tools) {
      assert.equal(t.annotations?.readOnlyHint, true, t.name);
      assert.equal(t.annotations?.destructiveHint, false, t.name);
      assert.ok(t.outputSchema, `${t.name} has no output schema`);
      assert.ok(
        t.inputSchema.properties?.['ignore_robots_txt'],
        `${t.name} lacks ignore_robots_txt`,
      );
      assert.ok((t.description ?? '').length > 100, `${t.name} needs a description`);
    }
    const { prompts } = await client.listPrompts();
    assert.deepEqual(
      prompts.map((p) => p.name),
      ['checkup'],
    );
    const p = await client.getPrompt({
      name: 'checkup',
      arguments: { url: 'https://example.com' },
    });
    const text = (p.messages[0]!.content as { text: string }).text;
    assert.match(text, /check_sitemaps and check_site/);
    assert.match(text, /three things to fix first/);
    assert.match(text, /ask me first/);
  } finally {
    await client.close();
  }
});
