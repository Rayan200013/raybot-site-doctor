// An MCP client connected to the server in the same process, as tests use it.
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { createServer } from '../../src/server.ts';
import type { ReportData } from '../../src/core/report.ts';

export interface Called {
  text: string;
  data: ReportData;
  isError: boolean;
  kinds: (severity?: 'fix-first' | 'worth-fixing' | 'note') => string[];
}

export async function connect(): Promise<{
  client: Client;
  call: (name: string, args: Record<string, unknown>) => Promise<Called>;
  close: () => Promise<void>;
}> {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverSide);
  const client = new Client({ name: 'site-doctor-tests', version: '0' });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown>): Promise<Called> => {
    const res = await client.callTool({ name, arguments: args }, { timeout: 10 * 60 * 1000 });
    const text = (res.content as { type: string; text?: string }[])
      .map((c) => c.text ?? '')
      .join('\n');
    const data = res.structuredContent as ReportData;
    return {
      text,
      data,
      isError: !!res.isError,
      kinds: (severity) =>
        (data?.findings ?? [])
          .filter((f) => !severity || f.severity === severity)
          .map((f) => f.kind),
    };
  };
  return {
    client,
    call,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
