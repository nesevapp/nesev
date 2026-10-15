# Security

## Threat model

nesev is a local, single-user app. It has **no authentication and no user accounts by design**: whoever can reach
its HTTP port can read and change all data, download every PDF and receipt, and trigger local programs it manages
(llama-server, whisper.cpp, the OCR helper).

To keep that safe:

- The server listens on `127.0.0.1` only. `NESEV_HOST` can change that; don't set it to `0.0.0.0` or a LAN/public
  address, and don't put nesev behind a reverse proxy, tunnel or port forward that other people can reach.
- The MCP server speaks over stdio only and opens no port.
- Local AI (llama-server) is started by nesev on `127.0.0.1` with a random API key per start.
- Your data lives in `data/` (or `NESEV_DATA_DIR`). Protect it like any other financial records: disk encryption,
  backups, file permissions.

Other software running on your machine (including browser pages, via DNS rebinding or CSRF-style requests to
`localhost`) is the main remaining risk. Reports in that area are especially welcome.

## Supported versions

Only the latest commit on `main` is supported. There are no release branches.

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Report them privately via GitHub private vulnerability
reporting (the "Report a vulnerability" button on the repository's Security tab).
<!-- TODO(owner): add the repository URL / a contact e-mail once the repo is public. -->

Include what you found, how to reproduce it and the impact you expect. You'll get an answer within a week. Once a fix
is available, the report can be published with credit to you, if you like.
