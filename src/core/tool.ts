// What every tool shares: its common arguments, its read-only annotations,
// progress while it runs, the 15-minute memory that lets `kind` re-read a
// check instead of running it again, and errors said plainly.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { render, reportSchema, type Report } from './report.ts';
import { RequestError } from './http.ts';
import { DEFAULT_DELAY_MS } from './site.ts';
import type { Progress } from './crawl.ts';

export const common = {
  ignore_robots_txt: z
    .boolean()
    .default(false)
    .describe(
      "Read pages even where the site's robots.txt disallows crawling. Pass true only when the user has said the site is theirs or that they may test it (staging sites usually disallow everything). The report then says at the top that robots.txt was ignored.",
    ),
  delay_ms: z
    .number()
    .int()
    .min(100)
    .max(10_000)
    .default(DEFAULT_DELAY_MS)
    .describe('Pause between two requests to the site, in milliseconds (one request at a time).'),
  kind: z
    .string()
    .optional()
    .describe(
      'Show only this kind of problem, with every example. Use a `kind` name from an earlier answer; for 15 minutes the same arguments re-read that check instead of checking again.',
    ),
};

export interface RunContext {
  signal: AbortSignal;
  progress: Progress;
}

export const ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const CACHE_MS = 15 * 60 * 1000;
const cache = new Map<string, { at: number; report: Report }>();

/** Something wrong with what was asked, said to the assistant as is. */
export class UserError extends Error {}

interface Spec<Shape extends z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  input: Shape;
  run: (args: z.infer<z.ZodObject<Shape>>, ctx: RunContext) => Promise<Report>;
}

export function defineTool<Shape extends z.ZodRawShape>(
  server: McpServer,
  spec: Spec<Shape>,
): void {
  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: z.object(spec.input),
      outputSchema: reportSchema,
      annotations: { title: spec.title, ...ANNOTATIONS },
    },
    async (args, ctx) => {
      const { kind, ...rest } = args as Record<string, unknown> & { kind?: string };
      const cacheKey = spec.name + JSON.stringify(rest, Object.keys(rest).sort());
      try {
        if (kind) {
          const hit = cache.get(cacheKey);
          if (hit && Date.now() - hit.at < CACHE_MS) {
            const out = render(hit.report, { kind, fromEarlier: true });
            return { content: [{ type: 'text', text: out.text }], structuredContent: out.data };
          }
        }
        const token = ctx.mcpReq._meta?.progressToken;
        let last = 0;
        const progress: Progress = (done, total, message) => {
          if (token === undefined) return;
          const now = Date.now();
          if (now - last < 300) return;
          last = now;
          void ctx.mcpReq
            .notify({
              method: 'notifications/progress',
              params: {
                progressToken: token,
                progress: done,
                ...(total ? { total } : {}),
                message,
              },
            })
            .catch(() => undefined);
        };
        const report = await spec.run(args as z.infer<z.ZodObject<Shape>>, {
          signal: ctx.mcpReq.signal,
          progress,
        });
        for (const [k, v] of cache) if (Date.now() - v.at >= CACHE_MS) cache.delete(k);
        cache.set(cacheKey, { at: Date.now(), report });
        const out = render(report, kind ? { kind } : {});
        return { content: [{ type: 'text', text: out.text }], structuredContent: out.data };
      } catch (e) {
        if (ctx.mcpReq.signal.aborted || (e instanceof RequestError && e.code === 'CANCELLED')) {
          return {
            content: [{ type: 'text', text: 'Stopped: the check was cancelled.' }],
            isError: true,
          };
        }
        const message =
          e instanceof UserError
            ? e.message
            : `The check could not finish: ${(e as Error).message}`;
        return { content: [{ type: 'text', text: message }], isError: true };
      }
    },
  );
}

/** The usual way a tool begins: an address, or a plain explanation of why it isn't one. */
export function parseTarget(input: string, toUrl: (s: string) => URL): URL {
  try {
    return toUrl(input);
  } catch (e) {
    throw new UserError(
      `"${input}" is not an address that can be checked: ${(e as Error).message}`,
    );
  }
}
