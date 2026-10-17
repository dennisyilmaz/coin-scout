import type { McpServer } from "@modelcontextprotocol/server";
import type { Config } from "../config.js";
import type { HeliusApi } from "../helius/api.js";
import { HeliusError } from "../helius/client.js";
import { fail, type ToolResult } from "../util/format.js";

export interface ToolContext {
  server: McpServer;
  api: HeliusApi;
  config: Config;
}

export function safe<T>(handler: (args: T) => Promise<ToolResult>) {
  return async (args: T): Promise<ToolResult> => {
    try {
      return await handler(args);
    } catch (error) {
      if (error instanceof HeliusError) {
        return fail(`Helius ${error.method} failed: ${error.message}`, {
          code: error.code,
          data: error.data,
        });
      }
      return fail(error instanceof Error ? error.message : String(error));
    }
  };
}

export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;
