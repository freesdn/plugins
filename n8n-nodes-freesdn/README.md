<!--
SPDX-License-Identifier: MIT
Copyright (C) 2024-2026 FreeSDN
-->

# n8n-nodes-freesdn

Community [n8n](https://n8n.io) nodes for **[FreeSDN](https://freesdn.org)** - the vendor-neutral
infrastructure controller. They turn FreeSDN's **Fabric** (its universal app-interconnect) into
first-class n8n building blocks, so you can wire your network/cameras/VoIP/storage estate into any
of n8n's 400+ integrations - including an external AI step that runs **outside** FreeSDN.

The canonical flow this enables:

> something happens in Omada → **FreeSDN** emits an event → **n8n** runs your logic (enrich, call an
> LLM, branch, wait) → calls back into **FreeSDN** → which stages a write to TrueNAS / Proxmox / a
> firewall.

This is intentionally **asynchronous**: two decoupled FreeSDN *Connections* bridged by the external
n8n hop, not one blocking round-trip.

## What's in the box

| | Type | What it does |
|---|---|---|
| **FreeSDN** | Action | `Invoke` any Fabric operation, or `Emit` an event back into FreeSDN. Plus convenience resources (Device / Alert / VLAN / Site / Controller / WiFi / Automation / Backup). |
| **FreeSDN Trigger** | Trigger | Registers a persistent FreeSDN webhook and starts your workflow when matching events fire (`device.status.changed`, `alert.fired`, `controller.sync.failed`, …). Verifies the timestamp-bound HMAC signature on every delivery. |
| **FreeSDN API** | Credential | `Server URL` + `API Key` (sent as `X-API-Key`), plus a required `Webhook Signing Secret` (the Trigger fails closed without it). |

The **Invoke** operation's dropdown is populated **live** from `GET /fabric/catalog`, so the node
self-updates as the connected FreeSDN gains capabilities - no node upgrade needed. Write operations
are labelled *"(writes - stages)"*: they never auto-apply, they enter FreeSDN's staged-change
pipeline for per-action operator sign-off.

## Install

**In n8n (recommended):** Settings → Community Nodes → Install → `n8n-nodes-freesdn`.

**Manually / for development:**

```bash
git clone https://github.com/freesdn/n8n-nodes-freesdn
cd n8n-nodes-freesdn
npm install
npm run build        # tsc + copy icons → dist/
```

Then point n8n at a directory **containing** the built package. n8n globs
`**/*.node.js` beneath each path in `N8N_CUSTOM_EXTENSIONS`, so give it a parent
directory holding only what you want loaded — aiming it at a development
checkout makes it walk `node_modules/` as well:

```bash
mkdir -p /opt/n8n-custom
ln -s "$PWD/dist" /opt/n8n-custom/freesdn
N8N_CUSTOM_EXTENSIONS=/opt/n8n-custom n8n start
```

Or with Docker:

```bash
docker run -p 5678:5678   -e N8N_CUSTOM_EXTENSIONS=/custom   -v "$PWD/dist:/custom/freesdn:ro"   docker.n8n.io/n8nio/n8n:latest
```

The nodes register as **FreeSDN** and **FreeSDN Trigger** in the node panel.

Requires n8n ≥ 1.0 (`n8nNodesApiVersion: 1`). Type-checked against `n8n-workflow@1.120`.

## Credential setup

1. In FreeSDN, create an **API key** with at least `event:write` (to emit/ingest) and whatever
   `*:read` / write permissions the operations you call require. Scoped keys work - the Fabric
   honors their scope.
2. In n8n, add a **FreeSDN API** credential: your server URL (`https://freesdn.example.com`) and the
   key. The credential **Test** button hits `GET /api/v1/health`.
3. *(Required for the Trigger - it fails closed without it)* set a **Webhook Signing Secret**. The Trigger registers
   its webhook with this secret; FreeSDN then HMAC-signs every delivery and the node rejects any POST
   that doesn't verify - so a spoofed (or replayed) hit on your public n8n URL is dropped. The
   signature is **timestamp-bound**: FreeSDN sends `X-Webhook-Timestamp: <unix>` and
   `X-Webhook-Signature: sha256=HMAC(secret, "<timestamp>.<rawBody>")`, and the node rejects a delivery
   whose timestamp is outside ±300 s of now (replay defense). Requires FreeSDN ≥ the release that ships
   timestamped signing; an older server (body-only signature, no timestamp) will be rejected - upgrade
   both together.

   > **Changing the secret (or the event set) later:** n8n has no webhook *update* hook, so a changed
   > credential only re-registers when the workflow is **re-activated** - toggle it **Off then On** after
   > editing the secret. The Trigger detects the drift (it fingerprints the registration) and PATCHes the
   > new secret/events onto the existing FreeSDN webhook on the next activation, rather than leaving the
   > server signing with the old secret (which the node would then reject).

## The two-Connection bridge

n8n sits **between** two FreeSDN Connections:

```
┌─ FreeSDN ─────────────┐        ┌─ n8n ──────────────┐        ┌─ FreeSDN ─────────────┐
│ Connection A (out)    │        │ FreeSDN Trigger     │        │ Connection B (in)     │
│ event: omada.* ──────────────▶ │  → your logic       │        │ event: ingest.external│
│ target: fabric.webhook│  HTTP  │  → (external AI…)   │  HTTP  │ → stage TrueNAS write │
└───────────────────────┘        │ FreeSDN: Emit ─────────────▶ │  (operator signs off) │
                                  └─────────────────────┘        └───────────────────────┘
```

- **Leg out** - Connection A's target is the built-in `fabric.webhook` op, which POSTs to your n8n
  webhook URL. It is SSRF-guarded; to reach a self-hosted n8n on your LAN/tailnet, allowlist its
  host via `FABRIC_WEBHOOK_ALLOWED_HOSTS` on the FreeSDN side (see `docs/FABRIC-N8N.md`).
- **Leg back** - the **FreeSDN: Emit** action posts to `POST /fabric/ingest`, which publishes a
  canonical `ingest.external` event. Connection B matches it (filter on `payload.name`) and runs the
  real action - riding staging + sign-off for any device write.

You can also skip the round-trip and call FreeSDN directly with **FreeSDN: Invoke** (e.g.
`storage.health`, `vm.snapshot`) anywhere in a workflow.

## Security model

- API key in `X-API-Key`; all calls scoped to the key's organization, fail-closed.
- Writes **never** auto-apply - they stage for operator sign-off (FreeSDN's dual-gate pipeline).
- Outbound `fabric.webhook` is SSRF-guarded (blocks loopback/private/link-local/CGNAT/cloud-metadata
  unless the host is explicitly allowlisted; metadata is *never* allowlistable).
- Inbound `/fabric/ingest` is permission-gated (`event:write`) and per-org rate-limited; the event
  type is always the canonical `ingest.external` (operator-supplied names are sanitized, never used
  as the event type - anti-spoof).
- The Trigger's HMAC (required signing secret) authenticates every delivery to your n8n URL and fails closed without it.

See **`docs/FABRIC-N8N.md`** in the FreeSDN repo for the full, copy-pasteable recipe.

## License

MIT. © FreeSDN.
