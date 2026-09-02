# mssql-mcp

A minimal, read-only [MCP](https://modelcontextprotocol.io) server for Microsoft SQL Server, served over Streamable HTTP from a persistent Docker container.

Only four tools exist — there is no insert/update/drop/create tool in the code at all. Every tool takes a required `database` parameter, constrained to a fixed enum built from config at startup:

- **list_tables** (`database`) — lists base tables (schema + name). `database` must be one of the configured data databases (`DB_NAMES`) — `master` is not accepted here.
- **describe_table** (`database`, `schema`, `table`) — lists columns for a given table (name, type, nullable, default, max length). Same `database` restriction as `list_tables`.
- **read_query** (`database`, `sql`, `maxRows?`, `maxRowsForJson?`) — runs a single `SELECT` (or `WITH ... SELECT`) statement. Anything else (DDL, DML, multiple statements, comments) is rejected before it reaches the database. Results are capped at `maxRows` (default 200, hard cap 1000). `database` accepts the data databases *and* `master`.

  Output format is chosen automatically based on result size: if the returned row count is `<= maxRowsForJson` (default **50**), the response is compact JSON (`{"format":"json","rows":[...],"rowCount":n,"truncated":bool}`), preserving exact types (numbers, booleans, `null`, ISO date strings). Above that threshold, the response switches to CSV (a few `key: value` metadata lines, a blank line, then the CSV body) to save tokens on large results — all values become text, and SQL `NULL` is written as the literal unquoted token `NULL` (distinguishable from an empty string). If a call needs JSON type fidelity for a bigger result, pass a larger `maxRowsForJson` to keep it in JSON. Caveat: a real value that is literally the string `"NULL"` is indistinguishable from a SQL NULL in CSV mode.
- **get_object_definition** (`database`, `schema`, `object`) — returns the SQL source (`CREATE PROCEDURE`/`VIEW`/`FUNCTION`/`TRIGGER` text) for an object, via `OBJECT_DEFINITION()`/`OBJECT_ID()`, using the login's VIEW DEFINITION permission. Returns `null` if the object doesn't exist or isn't visible. `database` accepts the data databases *and* `master`.

`master` is intentionally excluded from `list_tables`/`describe_table` (meant for browsing app schema) but usable in `read_query`/`get_object_definition` for querying system/catalog metadata and object definitions.

This is defense-in-depth on top of the SQL login itself, which should already be a read-only user with reader access to the two data databases plus reader + VIEW DEFINITION access to `master`.

## Setup

1. Copy `.env.example` to `.env` (or to `.env.local` if you're running without nginx — see [Running locally without nginx](#running-locally-without-nginx)) and fill in your SQL Server connection details:
   ```
   cp .env.example .env
   ```
   - `DB_SERVER` / `DB_PORT` — where your SQL Server instance lives.
   - `DB_NAMES` — comma-separated list of the databases the login can read (e.g. `Db1,Db2`). `master` is always available in addition to these and does not need to be listed.
   - `DB_USER` / `DB_PASSWORD` — the read-only SQL login.
   - `DB_ENCRYPT` — leave `true` unless your SQL Server doesn't support TLS.
   - `DB_TRUST_SERVER_CERTIFICATE` — set `true` only if the instance uses a self-signed certificate you trust.
   - `MCP_PORT` — port the server listens on inside the container (defaults to `8090` if unset). Leave at `8199` to match the host port mapping in both `docker-compose.yml` and `docker-compose.local.yml`.
   - `MCP_USE_AUTH` — `1` to require the bearer token below, `0` to disable auth entirely. **Leaving it unset behaves like `0` (auth disabled)** — always set it explicitly. Keep this `1` whenever the server is reachable by anything other than yourself (i.e. the nginx-fronted setup below). Only set it to `0` for the local/trusted-network setup.
   - `MCP_AUTH_TOKEN` — a random shared secret clients must send as `Authorization: Bearer <token>`. Generate one with `openssl rand -hex 32`. Required if `MCP_USE_AUTH=1` (the server refuses to start without it); can be left empty if `MCP_USE_AUTH=0`.

2. Build and start the container. There are two ways to run it — pick one:

   - **Behind nginx (recommended)** — uses `docker-compose.yml` + `.env`, binds only to `127.0.0.1:8199` on the host, and needs the separate nginx stack (see below) for any external access:
     ```
     docker compose up --build -d
     ```
   - **Without nginx** — uses `docker-compose.local.yml` + `.env.local`; see [Running locally without nginx](#running-locally-without-nginx) below before using this.
     ```
     docker compose -f docker-compose.local.yml up --build -d
     ```

   Either way it runs continuously (`restart: unless-stopped`). Only one can run at a time — both use `container_name: mssql-mcp`.

3. Check logs:
   ```
   docker compose logs -f mssql-mcp
   ```

## nginx reverse proxy (TLS termination)

TLS termination and public exposure are handled by a separate, standalone nginx stack at `/srv/docker/nginx` — not part of this project — so it can front other services too. It terminates TLS on port `443` and proxies `/mcp` to this container over a shared external Docker network named `proxy`. `mssql-mcp` itself only binds to `127.0.0.1:8199` on the host, for local debugging; nginx is the only externally reachable entry point.

Both stacks reference the `proxy` network as `external: true`, so it must exist before either is started:
```
docker network create proxy
```

See `/srv/docker/nginx/conf.d/mssql-mcp.conf` for the proxy config, and `/srv/docker/nginx/README.md` for cert-regeneration instructions. This repo also carries a copy of that same server block at `examples/mssql-mcp.example.conf`, so you don't need access to `/srv/docker/nginx` to see (or reuse) what the proxy config looks like — copy it into that nginx stack's `conf.d/` if setting the proxy up from scratch.

## Running locally without nginx

For a trusted host/network where TLS termination and a reverse proxy aren't needed, use `docker-compose.local.yml` instead of `docker-compose.yml`:

```
cp .env.example .env.local
docker compose -f docker-compose.local.yml up --build -d
```

This differs from the nginx-fronted setup in a few ways:

- It reads `.env.local` instead of `.env`.
- It publishes port `8199` on **all interfaces** (`0.0.0.0`), not just `127.0.0.1` — anything that can reach the host on the network can reach `/mcp` directly, over plain HTTP (no TLS).
- It uses its own bridge network (`mssql-loc`) instead of the shared external `proxy` network, so `docker network create proxy` isn't needed for this path.

Because there's no nginx in front to terminate TLS or require a token, set `MCP_USE_AUTH=0` only if the host/network is trusted; otherwise leave `MCP_USE_AUTH=1` and set `MCP_AUTH_TOKEN` even in this mode.

## Connecting a client

Point Claude Desktop / Claude Code at the running server (Streamable HTTP transport, not a launched command).

Behind nginx, passing the bearer token as a header:

```json
{
  "mcpServers": {
    "mssql": {
      "type": "http",
      "url": "https://<host>/mcp",
      "headers": {
        "Authorization": "Bearer <value of MCP_AUTH_TOKEN>"
      }
    }
  }
}
```

Use the host's LAN IP (or hostname, once you have DNS pointing at it) for `<host>`. No port is needed — nginx listens on the standard HTTPS port 443.

Running locally without nginx (`docker-compose.local.yml`), plain HTTP on port `8199` — drop the `headers` block entirely if `MCP_USE_AUTH=0`, keep it (with `http://` in the URL) if you left auth on:

```json
{
  "mcpServers": {
    "mssql": {
      "type": "http",
      "url": "http://<host>:8199/mcp"
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
- When `MCP_USE_AUTH=1`, every request to `/mcp` requires `Authorization: Bearer <MCP_AUTH_TOKEN>`; a missing or wrong token gets a 401. This is a single shared secret, not per-user identity — anyone with the token has full read access. Rotate it (update `.env`/`.env.local`, `docker compose up -d`) if it ever leaks, and update every connected client's config.
- `MCP_USE_AUTH=0` — or leaving it unset — disables that check entirely; every request is treated as authorized regardless of headers. Only use this with `docker-compose.local.yml` on a trusted host/network; never set it to `0` (or leave it unset) on the nginx-fronted setup, since nginx has no auth of its own and `/mcp` would become unauthenticated for anyone who can reach it.
