# mssql-mcp

A minimal, read-only [MCP](https://modelcontextprotocol.io) server for Microsoft SQL Server, served over Streamable HTTP from a persistent Docker container.

Only four tools exist — there is no insert/update/drop/create tool in the code at all. Every tool takes a required `database` parameter, constrained to a fixed enum built from config at startup:

- **list_tables** (`database`) — lists base tables (schema + name). `database` must be one of the configured data databases (`DB_NAMES`) — `master` is not accepted here.
- **describe_table** (`database`, `schema`, `table`) — lists columns for a given table (name, type, nullable, default). Same `database` restriction as `list_tables`.
- **read_query** (`database`, `sql`, `maxRows?`, `maxRowsForJson?`) — runs a single `SELECT` (or `WITH ... SELECT`) statement. Anything else (DDL, DML, multiple statements, comments) is rejected before it reaches the database. Results are capped at `maxRows` (default 200, hard cap 1000). `database` accepts the data databases *and* `master`.

  Output format is chosen automatically based on result size: if the returned row count is `<= maxRowsForJson` (default **50**), the response is compact JSON (`{"format":"json","rows":[...],"rowCount":n,"truncated":bool}`), preserving exact types (numbers, booleans, `null`, ISO date strings). Above that threshold, the response switches to CSV (a few `key: value` metadata lines, a blank line, then the CSV body) to save tokens on large results — all values become text, and SQL `NULL` is written as the literal unquoted token `NULL` (distinguishable from an empty string). If a call needs JSON type fidelity for a bigger result, pass a larger `maxRowsForJson` to keep it in JSON. Caveat: a real value that is literally the string `"NULL"` is indistinguishable from a SQL NULL in CSV mode.
- **get_object_definition** (`database`, `schema`, `object`) — returns the SQL source (`CREATE PROCEDURE`/`VIEW`/`FUNCTION`/`TRIGGER` text) for an object, via `OBJECT_DEFINITION()`/`OBJECT_ID()`, using the login's VIEW DEFINITION permission. Returns `null` if the object doesn't exist or isn't visible. `database` accepts the data databases *and* `master`.

`master` is intentionally excluded from `list_tables`/`describe_table` (meant for browsing app schema) but usable in `read_query`/`get_object_definition` for querying system/catalog metadata and object definitions.

This is defense-in-depth on top of the SQL login itself, which should already be a read-only user with reader access to the two data databases plus reader + VIEW DEFINITION access to `master`.

## Setup

1. Copy `.env.example` to `.env` and fill in your SQL Server connection details:
   ```
   cp .env.example .env
   ```
   - `DB_SERVER` / `DB_PORT` — where your SQL Server instance lives.
   - `DB_NAMES` — comma-separated list of the databases the login can read (e.g. `Db1,Db2`). `master` is always available in addition to these and does not need to be listed.
   - `DB_USER` / `DB_PASSWORD` — the read-only SQL login.
   - `DB_ENCRYPT` — leave `true` unless your SQL Server doesn't support TLS.
   - `DB_TRUST_SERVER_CERTIFICATE` — set `true` only if the instance uses a self-signed certificate you trust.

2. Build and start the container:
   ```
   docker compose up --build -d
   ```
   This runs continuously (`restart: unless-stopped`) and binds only to `localhost:8090` on this machine — it is not reachable from other machines on the network.

3. Check logs:
   ```
   docker compose logs -f mssql-mcp
   ```

## Connecting a client

Point Claude Desktop / Claude Code at the running server (Streamable HTTP transport, not a launched command):

```json
{
  "mcpServers": {
    "mssql": {
      "type": "http",
      "url": "http://localhost:8090/mcp"
    }
  }
}
```

## Local development (without Docker)

```
npm install
npm run build
npm start
```

## Notes

- The server is stateless (no MCP session persistence) — each HTTP request gets a fresh transport/server pair. GET and DELETE on `/mcp` return 405 since there's no session stream or session to delete.
- There is no auth in front of `/mcp`; the security boundary is the `localhost`-only port binding in `docker-compose.yml`. If you ever expose this beyond the local machine, add authentication first.
