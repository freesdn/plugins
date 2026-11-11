"""
FreeSDN Plugin - Template
=========================

Starting point for a FreeSDN plugin. Copy this folder, rename it, and edit
``plugin.yaml`` and this file.

Lifecycle:
  on_install()   - called once, at first install
  on_start()     - called every time FreeSDN starts (per organization)
  on_upgrade()   - called when the plugin version changes
  on_uninstall() - called just before removal

After ``super().on_start()`` runs, ``self.ctx`` exposes the SDK surface:
  self.ctx.devices   - read-only device inventory
  self.ctx.alerts    - read and create/resolve alerts
  self.ctx.events    - emit and subscribe to events
  self.ctx.settings  - plugin-scoped settings and secrets
  self.ctx.http      - SSRF-protected outbound HTTP client
  self.ctx.logger    - pre-configured logger

Docs: https://docs.freesdn.org/plugins/
"""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter
from freesdn_sdk import FreeSDNPlugin


class MyPlugin(FreeSDNPlugin):
    """Plugin entry point. FreeSDN loads this class based on ``class_name``
    in plugin.yaml."""

    # ── Lifecycle hooks ─────────────────────────────────────────────

    async def on_install(self, db) -> None:
        """First-time setup. Runs once when the plugin is installed."""
        self.ctx.logger.info("my-plugin installed")

    async def on_start(self, organization_id: UUID, db=None) -> None:
        """Runs on every startup for this organization."""
        await super().on_start(organization_id, db)

        # Example: read a setting, scan offline devices, raise an alert each.
        setting = await self.ctx.settings.get("example_setting", "hello")
        self.ctx.logger.info("my-plugin started (example_setting=%s)", setting)

        offline = await self.ctx.devices.list(status="offline", limit=10)
        for device in offline:
            await self.ctx.alerts.create(
                title=f"Device offline: {device['name']}",
                message=f"{device['name']} was detected offline at startup.",
                severity="warning",
                device_id=UUID(device["id"]) if device.get("id") else None,
            )

        # Emitted on the bus as "plugin.my-plugin.startup_complete".
        await self.ctx.events.emit(
            "startup_complete", {"offline_count": len(offline)}
        )

    async def on_uninstall(self, db) -> None:
        """Cleanup before removal."""
        self.ctx.logger.info("my-plugin uninstalled")

    # ── REST API ────────────────────────────────────────────────────

    def get_router(self) -> APIRouter:
        """Endpoints mount under /api/v1/my-plugin/ (the api_prefix)."""
        router = APIRouter()

        @router.get("/")
        async def status():
            """GET /api/v1/my-plugin/ - plugin status."""
            return {"plugin": "my-plugin", "status": "running"}

        @router.post("/check")
        async def run_check():
            """POST /api/v1/my-plugin/check - run a manual check."""
            if not self.ctx:
                return {"checked": False, "error": "Plugin not started"}

            offline = await self.ctx.devices.list(status="offline", limit=50)
            await self.ctx.events.emit(
                "check_complete", {"offline_count": len(offline)}
            )
            return {"checked": True, "offline_count": len(offline)}

        return router
