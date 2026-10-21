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
  const url = trustedUrl(options.url);
  let connected: Promise<Client> | null = null;
  const connect = () => {
    connected ??= (async () => {
      const client = new Client({ name: 'elizaos-plugin-central-city', version: '0.1.0' });
      const transport = new StreamableHTTPClientTransport(url, {
        // No redirects: the key is never sent to another origin.
        requestInit: { headers: { Authorization: `Bearer ${options.workspaceKey}` }, redirect: 'error' },
      });
      await client.connect(transport);
      return client;
    })().catch((error) => {
      connected = null; // try again on the next call
      throw error;
    });
    return connected;
  };
  const scrub = (text: string) => redact(text, options.workspaceKey);
  return {
    async call(tool, args) {
      let result;
      try {
        const client = await connect();
        result = await client.callTool({ name: tool, arguments: args });
      } catch (error) {
        // Transport errors may echo request details: never let the key through.
        throw new CityToolError(tool, scrub(error instanceof Error ? error.message : String(error)));
      }
      if (result.isError) throw new CityToolError(tool, scrub(textOf(result)));
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

/** Removes the workspace key and anything shaped like a Central City key or bearer token. */
export function redact(text: string, key?: string): string {
  let out = key ? text.split(key).join('[redacted]') : text;
  return out.replace(/\bccw_[A-Za-z0-9_-]+/g, '[redacted]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
}

/** The workspace key only ever goes to Central City over https (centralcity.ai or a subdomain). */
export function trustedUrl(value?: string): URL {
  const url = new URL(value ?? DEFAULT_MCP_URL);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || !(host === 'centralcity.ai' || host.endsWith('.centralcity.ai')) || url.username || url.password)
    throw new Error('CENTRAL_CITY_MCP_URL must be an https URL on centralcity.ai.');
  return url;
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
