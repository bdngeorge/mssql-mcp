import crypto from "node:crypto";
import express, { NextFunction, Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { listTables } from "./tools/listTables.js";
import { describeTable } from "./tools/describeTable.js";
import { readQuery } from "./tools/readQuery.js";
import { formatReadQueryResult } from "./tools/csvFormat.js";
import { getObjectDefinition } from "./tools/getObjectDefinition.js";
import { closeAllPools } from "./db.js";
import {
  SERVERS,
  DEFAULT_SERVER,
  resolveServer,
  resolveDataDatabase,
  resolveDatabase,
} from "./config.js";

function describeServers(includeMaster: boolean): string {
  return SERVERS.map((s) => {
    const dbs = includeMaster ? [...s.databases, "master"] : s.databases;
    const defaultDb = s.defaultDatabase ?? s.databases[0];
    const marker = s === DEFAULT_SERVER ? " [default server]" : "";
    return `${s.nickname}${marker}: databases=[${dbs.join(", ")}] (default database: ${defaultDb})`;
  }).join("; ");
}

const serverField = z
  .string()
  .optional()
  .describe(`Server nickname to target. Optional — defaults to the default server. Servers: ${describeServers(false)}`);

const dataDbField = z
  .string()
  .optional()
  .describe(
    `Database to query (master not allowed here). Optional — defaults to the target server's ` +
      `default database. Per-server lists: ${describeServers(false)}`
  );

const allDbField = z
  .string()
  .optional()
  .describe(
    `Database to query, including master. Optional — defaults to the target server's default ` +
      `database. Per-server lists: ${describeServers(true)}`
  );

function errorResult(err: unknown) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
  };
}

function buildServer(): McpServer {
  const server = new McpServer({ name: "mssql-mcp", version: "1.0.0" });

  server.registerTool(
    "list_servers",
    {
      title: "List Servers",
      description:
        "List configured SQL Server instances and their available databases, including which " +
        "server/database is used by default when not specified. master is always additionally " +
        "available on read_query/get_object_definition but is omitted from the databases lists here.",
      inputSchema: {},
    },
    async () => {
      const result = SERVERS.map((s) => ({
        nickname: s.nickname,
        isDefault: s === DEFAULT_SERVER,
        databases: s.databases,
        defaultDatabase: s.defaultDatabase ?? s.databases[0],
      }));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "list_tables",
    {
      title: "List Tables",
      description: "List all base tables (schema + name) in the given server/database.",
      inputSchema: {
        server: serverField,
        database: dataDbField,
      },
    },
    async ({ server: serverArg, database: databaseArg }) => {
      try {
        const serverCfg = resolveServer(serverArg);
        const database = resolveDataDatabase(serverCfg, databaseArg);
        const tables = await listTables(serverCfg, database);
        return { content: [{ type: "text", text: JSON.stringify(tables, null, 2) }] };
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "describe_table",
    {
      title: "Describe Table",
      description: "List columns (name, data type, nullability, default) for a table.",
      inputSchema: {
        server: serverField,
        database: dataDbField,
        schema: z.string().default("dbo").describe("Schema name, defaults to dbo"),
        table: z.string().describe("Table name"),
      },
    },
    async ({ server: serverArg, database: databaseArg, schema, table }) => {
      try {
        const serverCfg = resolveServer(serverArg);
        const database = resolveDataDatabase(serverCfg, databaseArg);
        const columns = await describeTable(serverCfg, database, schema, table);
        return { content: [{ type: "text", text: JSON.stringify(columns, null, 2) }] };
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "read_query",
    {
      title: "Read Query",
      description:
        "Run a single read-only SELECT (or WITH ... SELECT) statement against the given " +
        "server/database. Rejects anything that is not exactly one SELECT statement. Includes " +
        "master (reader + view-definition access only, for querying system/catalog metadata). " +
        "Output is JSON when the result has maxRowsForJson rows or fewer (preserves exact types), " +
        "and CSV above that (more compact, but all values are text; SQL NULL is written as the " +
        "literal token NULL).",
      inputSchema: {
        server: serverField,
        database: allDbField,
        sql: z.string().describe("A single SELECT statement"),
        maxRows: z
          .number()
          .int()
          .positive()
          .max(1000)
          .optional()
          .describe("Max rows to return (default 200, hard cap 1000)"),
        maxRowsForJson: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Row-count threshold for output format (default 50). Results with this many rows or " +
              "fewer are returned as JSON (exact types); more than this switches to CSV (compact, " +
              "text-only). Raise this if you need JSON type fidelity for a larger result."
          ),
      },
    },
    async ({ server: serverArg, database: databaseArg, sql, maxRows, maxRowsForJson }) => {
      try {
        const serverCfg = resolveServer(serverArg);
        const database = resolveDatabase(serverCfg, databaseArg);
        const result = await readQuery(serverCfg, database, sql, maxRows);
        const text = formatReadQueryResult(result, maxRowsForJson ?? 50);
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "get_object_definition",
    {
      title: "Get Object Definition",
      description:
        "Return the SQL source (CREATE PROCEDURE/VIEW/FUNCTION/TRIGGER text) for a database object, " +
        "using the login's VIEW DEFINITION permission. Returns null if the object doesn't exist or " +
        "isn't visible to this login. Includes master.",
      inputSchema: {
        server: serverField,
        database: allDbField,
        schema: z.string().default("dbo").describe("Schema name, defaults to dbo"),
        object: z.string().describe("Object name (procedure, view, function, trigger, ...)"),
      },
    },
    async ({ server: serverArg, database: databaseArg, schema, object }) => {
      try {
        const serverCfg = resolveServer(serverArg);
        const database = resolveDatabase(serverCfg, databaseArg);
        const result = await getObjectDefinition(serverCfg, database, schema, object);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  return server;
}

const useAuth = Boolean(Number(process.env.MCP_USE_AUTH));
const authToken = process.env.MCP_AUTH_TOKEN;
if (useAuth && !authToken) {
  throw new Error("Missing required environment variable: MCP_AUTH_TOKEN");
}

function checkAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.header("authorization") ?? "";
  const [scheme, token] = header.split(" ");
  const provided = Buffer.from(scheme === "Bearer" ? token ?? "" : "");
  const expected = Buffer.from(authToken as string);
  const authorized =
    provided.length === expected.length && crypto.timingSafeEqual(provided, expected);

  if (!authorized) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized: missing or invalid bearer token." },
      id: null,
    });
    return;
  }
  next();
}

const app = express();
app.use(express.json());
if (useAuth) {
  app.use("/mcp", checkAuth);
}

// Stateless Streamable HTTP: a fresh server + transport per request avoids
// cross-request session bugs and keeps this simple for a single local client.
app.post("/mcp", async (req: Request, res: Response) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("Error handling MCP request:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.get("/mcp", (_req: Request, res: Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed: stateless server does not support GET streams." },
    id: null,
  });
});

app.delete("/mcp", (_req: Request, res: Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed: stateless server does not support session deletion." },
    id: null,
  });
});

const port = Number(process.env.MCP_PORT ?? 8090);
const httpServer = app.listen(port, () => {
  console.log(`mssql-mcp listening on port ${port}`);
});

async function shutdown(): Promise<void> {
  console.log("Shutting down...");
  httpServer.close();
  await closeAllPools();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
