import express, { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { listTables } from "./tools/listTables.js";
import { describeTable } from "./tools/describeTable.js";
import { readQuery } from "./tools/readQuery.js";
import { getObjectDefinition } from "./tools/getObjectDefinition.js";
import { DATA_DATABASES, ALL_DATABASES, closeAllPools } from "./db.js";

const dataDbEnum = z.enum(DATA_DATABASES as [string, ...string[]]);
const allDbEnum = z.enum(ALL_DATABASES as [string, ...string[]]);

const dataDbDescription = `Database to query. One of: ${DATA_DATABASES.join(", ")}`;
const allDbDescription = `Database to query. One of: ${ALL_DATABASES.join(", ")}`;

function buildServer(): McpServer {
  const server = new McpServer({ name: "mssql-mcp", version: "1.0.0" });

  server.registerTool(
    "list_tables",
    {
      title: "List Tables",
      description: "List all base tables (schema + name) in the given database.",
      inputSchema: {
        database: dataDbEnum.describe(dataDbDescription),
      },
    },
    async ({ database }) => {
      const tables = await listTables(database);
      return { content: [{ type: "text", text: JSON.stringify(tables, null, 2) }] };
    }
  );

  server.registerTool(
    "describe_table",
    {
      title: "Describe Table",
      description: "List columns (name, data type, nullability, default) for a table.",
      inputSchema: {
        database: dataDbEnum.describe(dataDbDescription),
        schema: z.string().default("dbo").describe("Schema name, defaults to dbo"),
        table: z.string().describe("Table name"),
      },
    },
    async ({ database, schema, table }) => {
      const columns = await describeTable(database, schema, table);
      return { content: [{ type: "text", text: JSON.stringify(columns, null, 2) }] };
    }
  );

  server.registerTool(
    "read_query",
    {
      title: "Read Query",
      description:
        "Run a single read-only SELECT (or WITH ... SELECT) statement against the given database. " +
        "Rejects anything that is not exactly one SELECT statement. Includes master (reader + " +
        "view-definition access only, for querying system/catalog metadata).",
      inputSchema: {
        database: allDbEnum.describe(allDbDescription),
        sql: z.string().describe("A single SELECT statement"),
        maxRows: z
          .number()
          .int()
          .positive()
          .max(1000)
          .optional()
          .describe("Max rows to return (default 200, hard cap 1000)"),
      },
    },
    async ({ database, sql, maxRows }) => {
      try {
        const result = await readQuery(database, sql, maxRows);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
        };
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
        database: allDbEnum.describe(allDbDescription),
        schema: z.string().default("dbo").describe("Schema name, defaults to dbo"),
        object: z.string().describe("Object name (procedure, view, function, trigger, ...)"),
      },
    },
    async ({ database, schema, object }) => {
      const result = await getObjectDefinition(database, schema, object);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  return server;
}

const app = express();
app.use(express.json());

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
