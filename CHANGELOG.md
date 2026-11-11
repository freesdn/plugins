# Changelog

All notable changes to this repository (the `n8n-nodes-freesdn` node, the
plugin template and the example plugins) are documented in this file. Its
version is the n8n node's.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Releases 1.0.0 to 1.0.3 predate this file.

## [2.0.0] - 2026-11-11

The n8n node's Get Many operations did not return what they said they would,
and one operation failed on every call. Fixing Get Many changes its output, so
this is a major version; see Upgrading.

### Changed

- **Get Many returns one n8n item per record** for devices, sites,
  controllers, automations, backups, VLANs, Wi-Fi networks and alerts. It
  returned the API's response envelope (`items`, `total`, `page` and so on) as a
  single item, and only its first page.

### Fixed

- **Return All and Limit did nothing useful.** Both were shown for every Get
  Many and read only by devices and alerts, which sent a `limit` the devices API
  ignores (it pages with `page` and `per_page`). Alerts sent `limit=1000` for
  Return All, which the alerts API, capped at 200, refuses. Each resource now
  pages the way its API does (`page`/`per_page`, `skip`/`limit` or
  `offset`/`limit`), 100 records per request, and stops at your limit or at the
  API's total.
- A Get Many response without its list now fails the node with "Invalid
  paginated response from FreeSDN" instead of returning nothing.
- **Backup > Create failed on every call.** It sent no name, which the API
  requires. A new Backup Name parameter defaults to "n8n configuration
  snapshot".
- **The FreeSDN Trigger could register its webhook twice.** When updating the
  existing registration failed for any reason, such as a timeout, a server error
  or a refusal, the trigger discarded it and registered a new one, although the
  old one might still exist. It now does that only when FreeSDN answers 404.
  Any other error is raised and the registration kept, so a retry cannot
  duplicate it.
- **`plugin-template`**: `pytest tests`, the command the template documents,
  failed at collection because nothing put the plugin root on `sys.path`. The
  template has a `tests/conftest.py`, and CI now runs that plain command. It
  used `PYTHONPATH=.`, which hid the failure.
- `examples/plugins/hello-world` 1.2.1: lint fixes only.
- **The install instructions installed a placeholder.** n8n's Community Nodes
  installer fetches `n8n-nodes-freesdn` from npm, where that name is a 0.0.1
  placeholder that reserves it. The READMEs now say to build the node from
  this repository, and no longer point at a `freesdn/n8n-nodes-freesdn`
  repository that does not exist, or at documentation paths that returned 404.
  "Requires n8n >= 1.0" is replaced by what was actually built against.

### Dependencies

The node ships only its compiled `dist/` and has no runtime dependencies;
`n8n-workflow` is a peer dependency your n8n provides. Everything below is
build and test tooling.

- `n8n-workflow` 2.46.5 (from 1.120.19), pinned exactly, for the types the node
  compiles against. Also TypeScript 7.0.2, `@types/node` 24.19.2 and Prettier
  3.9.10. Overrides keep `axios` at 1.20.0 or later and `follow-redirects` at
  1.16.2 or later.
- `npm audit` reports one advisory, the same as for 1.0.3: zod
  GHSA-mrhx-c7xc-m3w5, through `n8n-workflow`, which uses zod 3. The fix is in
  zod 4.6.6; it is development-only and not in the shipped node.
- CI uses Node 24.22.2 and npm 12.2.2 (it used Node 22 and fell back from
  `npm ci` to `npm install`), and now runs a test suite against the compiled
  node: requests, pagination, webhook registration and signature checks.
- A Dependabot configuration for notifications. Dependency changes are made
  upstream; this repository is regenerated on release.
- A release candidate is now pushed to a `qualification/<version>` branch
  first, and CI must pass there before `main` moves and the tag is pushed.

### Upgrading

- A workflow that reads `items` (or `alerts`) from a Get Many output needs that
  step removed: each record is now its own item. Delete the node that split
  `items`, and refer to fields as `$json.<field>`.
- `n8n-nodes-freesdn` on npm is still a name-reservation placeholder (0.0.1),
  so n8n's Community Nodes installer does not install this node. Build it from
  this repository and install it as a custom node.
- The node is built against the n8n 2.x node types and has not been tested in
  an n8n 1.x host.
