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

- Against browser pages (DNS rebinding, CSRF-style requests to `localhost`) every request must carry a loopback
  `Host` (`localhost`, `127.0.0.1`, `[::1]`, any port), and writes with a foreign `Origin` or
  `Sec-Fetch-Site: cross-site` are refused (403). Extra hostnames go into `NESEV_ALLOWED_HOSTS` (comma-separated);
  a specific `NESEV_HOST` address is allowed automatically.

- Every response carries `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and same-origin framing
  only; HTML pages (the built SPA) get a Content Security Policy (scripts only from nesev itself, no plugins, no
  foreign frames or form targets). Files from `data/` (logos, receipts) are served with nosniff, and SVG/XML/HTML
  files additionally in a CSP sandbox, so an uploaded file can't run script in nesev's origin.
- Logo uploads are typed by their content, not the browser's MIME type. SVG logos must be plain vector graphics:
  scripts, event handlers, `javascript:` links, HTML content and references to outside files are refused.
- Imported files (bank statements, e-invoices, receipts) are untrusted input: upload sizes are capped before
  parsing, embedded PDF files are inflated with a size cap, and CSV exports neutralize cell values that a
  spreadsheet would run as a formula (`=`, `+`, `-`, `@` at the start get a leading `'`).
- The in-app assistant is a small local model that reads untrusted text (receipts, client data). It can't do anything
  the API can't, and every tool that changes existing records (finalize, payments, bank matching, record and draft
  updates) runs only after a click on a confirmation card that names the change. It has no access to local files.
  The MCP server for desktop clients may attach a receipt from a local path, but only files inside your home folder
  that are a PDF/JPG/PNG/WebP by content. Links to other sites in assistant answers show their target domain.

Other software running on your machine (including other local web apps on `localhost`) is the main remaining risk.
Reports in that area are especially welcome.

## Supported versions

Only the latest commit on `main` is supported. There are no release branches.

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Report them privately via GitHub private vulnerability
reporting (the "Report a vulnerability" button on the repository's Security tab).
<!-- TODO(owner): add the repository URL / a contact e-mail once the repo is public. -->

Include what you found, how to reproduce it and the impact you expect. You'll get an answer within a week. Once a fix
is available, the report can be published with credit to you, if you like.
