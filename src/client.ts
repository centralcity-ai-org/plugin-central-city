import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/** The calls this plugin makes; a test passes its own. */
export interface CityCaller {
  call(tool: string, args: Record<string, unknown>): Promise<unknown>;
}

export const DEFAULT_MCP_URL = 'https://centralcity.ai/mcp';

/**
 * Calls Central City's remote MCP server with a workspace key (Authorization: Bearer ccw_...).
 * One connection is opened on first use and reused. The key is never logged or returned.
 */
export function createCityClient(options: { workspaceKey: string; url?: string }): CityCaller {
  let connected: Promise<Client> | null = null;
  const connect = () => {
    connected ??= (async () => {
      const client = new Client({ name: 'elizaos-plugin-central-city', version: '0.1.0' });
      const transport = new StreamableHTTPClientTransport(new URL(options.url ?? DEFAULT_MCP_URL), {
        requestInit: { headers: { Authorization: `Bearer ${options.workspaceKey}` } },
      });
      await client.connect(transport);
      return client;
    })().catch((error) => {
      connected = null; // try again on the next call
      throw error;
    });
    return connected;
  };
  return {
    async call(tool, args) {
      const client = await connect();
      const result = await client.callTool({ name: tool, arguments: args });
      if (result.isError) throw new CityToolError(tool, textOf(result));
      if ((result as { structuredContent?: unknown }).structuredContent) return (result as { structuredContent?: unknown }).structuredContent;
      const text = textOf(result);
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    },
  };
}

export class CityToolError extends Error {
  constructor(
    readonly tool: string,
    detail: string,
  ) {
    super(`${tool} failed: ${detail.slice(0, 300)}`);
  }
}

function textOf(result: unknown): string {
  const raw = (result as { content?: unknown })?.content;
  const content = Array.isArray(raw) ? raw : [];
  return content
    .filter((part): part is { type: 'text'; text: string } => part?.type === 'text')
    .map((part) => part.text)
    .join('\n');
}
