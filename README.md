# FreeSDN Plugins

Official first-party plugins for [FreeSDN](https://freesdn.org), plus the
plugin template and worked examples for building your own.

**License:** MIT &nbsp;|&nbsp; **SDK:** [github.com/freesdn/freesdn-sdk](https://github.com/freesdn/freesdn-sdk) &nbsp;|&nbsp; **Docs:** [docs.freesdn.org/plugins](https://docs.freesdn.org/plugins/)

---

## What is in this repo

```
plugins/
  n8n-nodes-freesdn/      # n8n community nodes for FreeSDN Fabric
  examples/
    plugins/
      hello-world/         # minimal SDK example
      notify-hub/          # alert-to-webhook fan-out example
  plugin-template/         # starting point for your own plugin
```

There is no plugin marketplace yet. That is deferred until there is enough
community traction to justify curating one responsibly. Until then, this
repo is the canonical home for anything the FreeSDN maintainer ships
alongside the core.

---

## n8n-nodes-freesdn

n8n community nodes that wire FreeSDN's Fabric (its universal
app-interconnect) into n8n workflows.

**Install in n8n:** Settings - Community Nodes - Install - `n8n-nodes-freesdn`

What you get:

| Node | Type | What it does |
|---|---|---|
| FreeSDN | Action | Invoke any Fabric operation or emit an event back into FreeSDN. Convenience resources for Device, Alert, VLAN, Site, Controller, WiFi, Automation, Backup. |
| FreeSDN Trigger | Trigger | Registers a persistent FreeSDN webhook; starts your workflow when matching events fire (`device.*`, `alert.created`, `controller.disconnected`, ...). Verifies the timestamp-bound HMAC signature on every delivery. |
| FreeSDN API | Credential | Server URL + API key, plus a required webhook signing secret (the Trigger fails closed and rejects all deliveries without it). |

The Invoke operation's dropdown is populated live from
`GET /fabric/catalog` on your connected FreeSDN instance, so as FreeSDN
gains capabilities the node self-updates without a node upgrade.

Write operations are labelled "writes - stages": they enter FreeSDN's
staged-change pipeline for operator sign-off and are never auto-applied.

### The two-leg bridge pattern

The canonical flow this enables:

```
FreeSDN (event out)
  --> n8n (your logic, enrich, call an external AI, branch, wait)
    --> FreeSDN (event in --> staged write --> operator sign-off)
```

The two FreeSDN connections are decoupled - the n8n hop is fully
asynchronous. See [docs/FABRIC-N8N.md](https://github.com/freesdn/freesdn/blob/main/docs/FABRIC-N8N.md)
in the core repo for the full recipe with copy-pasteable config.

### Security notes

- All calls are scoped to the API key's organization; fail-closed.
- Outbound webhook delivery is SSRF-guarded on the FreeSDN side (blocks
  loopback, private ranges, link-local, CGNAT, cloud metadata). To reach
  a self-hosted n8n on your LAN or tailnet, allowlist its host via
  `FABRIC_WEBHOOK_ALLOWED_HOSTS` in the FreeSDN environment.
- The webhook signing secret is mandatory; Trigger deliveries are
  timestamp-bound and HMAC-signed, and the node rejects deliveries
  outside a 5-minute window (replay defense). With no secret the
  Trigger fails closed and accepts nothing.
- Inbound `/fabric/ingest` is permission-gated and per-org rate-limited.

### Build from source

```bash
git clone https://github.com/freesdn/plugins
cd plugins/n8n-nodes-freesdn
npm install
npm run build          # tsc + copy icons -> dist/
```

Requires n8n >= 1.0.

---

## Examples

### hello-world

A minimal plugin that demonstrates the basic SDK contract: one event
subscription, one custom API endpoint, a test that uses the mock context.
Read this first.

### notify-hub

A practical plugin: receives FreeSDN alerts and fans them out to one or
more external webhooks, with per-org configuration stored as encrypted
plugin settings. Demonstrates `settings.get_secret`, the SSRF-protected
HTTP client, and how to write tests against configurable behavior.

---

## Build your own plugin

You do not need to contribute to this repo or to the core to extend
FreeSDN. Build your plugin in its own repo using the
[FreeSDN SDK](https://github.com/freesdn/freesdn-sdk):

```bash
pip install "freesdn-sdk[dev]"
freesdn-sdk init my-plugin
cd my-plugin
# implement, test, package
freesdn-sdk package .
```

Or start from `plugin-template/` in this repo - copy the folder, rename it,
and edit `plugin.yaml` and `plugin.py`.

Upload the resulting ZIP in the FreeSDN web UI under Settings - Plugins.
Installation is restricted to `super_admin` users. Review the plugin code
and `plugin.yaml` before you install anything you did not write yourself -
plugins run in-process with the backend and are not OS-sandboxed.

The SDK README and [docs.freesdn.org/plugins](https://docs.freesdn.org/plugins/)
cover the full API surface, lifecycle hooks, testing utilities, and the
honest security model.

---

## Contributing

The core project does not accept external code contributions (that policy
is explained in the [core repo](https://github.com/freesdn/freesdn/blob/main/CONTRIBUTING.md)).
This repo follows the same policy - code PRs will not be merged.

Bug reports and questions about the n8n nodes or the examples are welcome
via GitHub Issues.

The two ways to support FreeSDN development:

- **Donate hardware** - device ownership transfers permanently to the
  maintainer; the device may be modified, reflashed, bricked, or
  destroyed in the course of reverse-engineering; it will not be
  returned; no compensation. In exchange, that vendor and model become
  permanently supported and tested, and the donor is credited
  (opt-in) on the supporters wall.
  Contact: [hardware@freesdn.org](mailto:hardware@freesdn.org)

- **Fuel the build** - gift a Claude or OpenAI Codex subscription
  (those two products only) to [fuel@freesdn.org](mailto:fuel@freesdn.org).
  This funds the AI-assisted development and audit pipeline directly.

FreeSDN accepts no cash, no sponsorships, and no tips. The no-money
stance is deliberate and permanent.

## License

MIT. See [LICENSE](LICENSE).
