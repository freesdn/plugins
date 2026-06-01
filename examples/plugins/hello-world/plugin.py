"""
FreeSDN Plugin — Hello World
==============================

A minimal example plugin demonstrating the FreeSDN Plugin SDK.

What this plugin does:
  1. On startup: scans for offline devices and creates alerts
  2. Exposes a REST API at /api/v1/hello-world/
  3. Emits custom events on the FreeSDN event bus
  4. Reads and writes plugin-scoped settings
  5. Makes a safe outbound HTTP request (SSRF-protected)

This file is the only Python file a plugin needs.  Everything else
is declared in plugin.yaml.

Docs: https://docs.freesdn.org/plugins/getting-started
"""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter

from freesdn_sdk import FreeSDNPlugin


class HelloWorldPlugin(FreeSDNPlugin):
    """
    Plugin entry point.  FreeSDN loads this class automatically based
    on the ``class_name`` field in plugin.yaml.

    Lifecycle:
      on_install()  → called once at first install
      on_start()    → called every time FreeSDN starts (per org)
      on_upgrade()  → called when the plugin version changes
      on_uninstall() → called just before removal
    """

    # ── Lifecycle Hooks ─────────────────────────────────────────────

    async def on_install(self, db) -> None:
        """First-time setup.  Seed default settings."""
        self.ctx.logger.info("Hello World plugin installed!")

    async def on_start(self, organization_id: UUID, db=None) -> None:
        """
        Called every time FreeSDN starts for this organization.

        After calling super(), self.ctx is available with typed SDK
        access to devices, alerts, events, settings, and HTTP.
        """
        await super().on_start(organization_id, db)

        # ── Example: read a plugin setting ──────────────────────────
        severity = await self.ctx.settings.get(
            "alert_severity", "warning"
        )
        self.ctx.logger.info(
            "Hello World started for org %s (alert severity: %s)",
            organization_id,
            severity,
        )

        # ── Example: scan for offline devices and create alerts ─────
        offline = await self.ctx.devices.list(status="offline", limit=10)
        for device in offline:
            await self.ctx.alerts.create(
                title=f"Device offline: {device['name']}",
                message=(
                    f"Device {device['name']} ({device['ip']}) "
                    f"has been detected as offline during plugin startup."
                ),
                severity=severity,
                device_id=UUID(device["id"]) if device.get("id") else None,
            )

        # ── Example: emit a custom event ────────────────────────────
        # Published as "plugin.hello-world.startup_complete"
        # Automation rules can trigger on this event.
        await self.ctx.events.emit("startup_complete", {
            "offline_count": len(offline),
            "organization_id": str(organization_id),
        })

    async def on_uninstall(self, db) -> None:
        """Cleanup before removal."""
        self.ctx.logger.info("Hello World plugin uninstalled.  Goodbye!")

    # ── REST API ────────────────────────────────────────────────────

    def get_router(self) -> APIRouter:
        """
        Define custom REST endpoints for this plugin.

        These are mounted at /api/v1/hello-world/ (from api_prefix
        in plugin.yaml).  All standard FastAPI features work:
        path params, query params, request bodies, dependencies, etc.
        """
        router = APIRouter()

        @router.get("/")
        async def hello():
            """GET /api/v1/hello-world/ — plugin status page."""
            return {
                "plugin": "hello-world",
                "status": "running",
                "message": "Hello from FreeSDN!",
            }

        @router.get("/devices/offline")
        async def offline_devices():
            """GET /api/v1/hello-world/devices/offline — list offline devices."""
            if not self.ctx:
                return {"devices": [], "error": "Plugin not started"}

            devices = await self.ctx.devices.list(status="offline", limit=50)
            return {
                "count": len(devices),
                "devices": devices,
            }

        @router.post("/check")
        async def run_check():
            """POST /api/v1/hello-world/check — trigger a manual check."""
            if not self.ctx:
                return {"checked": False, "error": "Plugin not started"}

            severity = await self.ctx.settings.get("alert_severity", "warning")
            offline = await self.ctx.devices.list(status="offline", limit=50)
            created = 0

            for device in offline:
                await self.ctx.alerts.create(
                    title=f"Device offline: {device['name']}",
                    message=f"Detected by Hello World plugin manual check.",
                    severity=severity,
                    device_id=UUID(device["id"]) if device.get("id") else None,
                )
                created += 1

            # Emit event so automation rules can react
            await self.ctx.events.emit("check_complete", {
                "offline_count": len(offline),
                "alerts_created": created,
            })

            return {
                "checked": True,
                "offline_count": len(offline),
                "alerts_created": created,
            }

        @router.get("/settings")
        async def get_settings():
            """GET /api/v1/hello-world/settings — view current config."""
            if not self.ctx:
                return {}
            return {
                "check_interval_minutes": await self.ctx.settings.get(
                    "check_interval_minutes", 60
                ),
                "alert_severity": await self.ctx.settings.get(
                    "alert_severity", "warning"
                ),
            }

        @router.get("/example-http")
        async def example_http():
            """
            GET /api/v1/hello-world/example-http — outbound HTTP demo.

            The PluginHTTPClient is SSRF-protected: private IPs,
            cloud metadata endpoints, and redirects are all blocked.
            """
            if not self.ctx:
                return {"error": "Plugin not started"}

            try:
                resp = await self.ctx.http.get(
                    "https://httpbin.org/get",
                    params={"plugin": "hello-world"},
                )
                return {
                    "status_code": resp.status_code,
                    "headers": dict(resp.headers),
                }
            except Exception as exc:
                return {"error": str(exc)}

        return router
