"""
FreeSDN Plugin — Notification Hub
===================================

Forwards FreeSDN alert / SLA / VPN events to external chat and push services.
A real, useful flagship that exercises the full plugin surface:

  * event_subscriptions + on_event()  → react to core events
  * self.ctx.settings                 → per-channel webhook config
  * self.ctx.http                     → SSRF-guarded outbound POSTs
  * get_router()                      → status + manual test-send endpoint

Channels: Discord, Slack, ntfy, Gotify, and a generic webhook. Each is
independent — configure any subset. Notifications are severity-filtered.

Authored against the published SDK (``from freesdn_sdk import FreeSDNPlugin``);
FreeSDN injects the real implementations at runtime.

Docs: https://docs.freesdn.org/plugins/getting-started
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

from fastapi import APIRouter

from freesdn_sdk import FreeSDNPlugin

# Severity ranking for the min_severity filter.
_SEVERITY_ORDER = {"info": 0, "warning": 1, "error": 2, "critical": 3}
# Map event-bus priority → a severity when the payload doesn't carry one.
_PRIORITY_TO_SEVERITY = {"low": "info", "normal": "warning", "high": "error", "critical": "critical"}


class NotifyHubPlugin(FreeSDNPlugin):
    """Fan-out notification plugin."""

    # ── Lifecycle ───────────────────────────────────────────────────────

    async def on_start(self, organization_id: UUID, db: Any = None) -> None:
        await super().on_start(organization_id, db)
        # bind_event_subscriptions() (called by the runtime) wires the manifest's
        # event_subscriptions to on_event() below.
        channels = await self._configured_channels()
        self.ctx.logger.info(
            "Notification Hub started for org %s — %d channel(s) configured: %s",
            organization_id,
            len(channels),
            ", ".join(channels) or "none",
        )

    # ── Event handling ──────────────────────────────────────────────────

    async def on_event(self, event: Any) -> None:
        """Called for each subscribed event (alert.*/sla.*/vpn.*)."""
        if not self.ctx:
            return
        if not await self.ctx.settings.get("enabled", True):
            return

        event_type = getattr(event, "event_type", "event")
        payload = getattr(event, "payload", None) or {}
        severity = self._severity_of(event, payload)

        min_sev = str(await self.ctx.settings.get("min_severity", "warning"))
        if _SEVERITY_ORDER.get(severity, 1) < _SEVERITY_ORDER.get(min_sev, 1):
            return

        title = str(payload.get("title") or payload.get("name") or event_type)
        message = str(
            payload.get("message")
            or payload.get("description")
            or f"FreeSDN event: {event_type}"
        )
        await self._dispatch(event_type=event_type, severity=severity, title=title, message=message)

    @staticmethod
    def _severity_of(event: Any, payload: dict[str, Any]) -> str:
        sev = payload.get("severity")
        if isinstance(sev, str) and sev.lower() in _SEVERITY_ORDER:
            return sev.lower()
        priority = str(getattr(event, "priority", "") or "").lower()
        return _PRIORITY_TO_SEVERITY.get(priority, "warning")

    # ── Dispatch ────────────────────────────────────────────────────────

    async def _configured_channels(self) -> list[str]:
        s = self.ctx.settings
        out = []
        if await s.get("discord_webhook_url"):
            out.append("discord")
        if await s.get("slack_webhook_url"):
            out.append("slack")
        if await s.get("ntfy_url"):
            out.append("ntfy")
        if await s.get("gotify_url") and await s.get("gotify_token"):
            out.append("gotify")
        if await s.get("generic_webhook_url"):
            out.append("generic")
        return out

    async def _dispatch(self, *, event_type: str, severity: str, title: str, message: str) -> dict[str, Any]:
        """Send to every configured channel; one channel's failure never blocks
        the others. Returns a per-channel result map (used by the test endpoint)."""
        s = self.ctx.settings
        results: dict[str, Any] = {}
        senders = {
            "discord": (await s.get("discord_webhook_url"), self._send_discord),
            "slack": (await s.get("slack_webhook_url"), self._send_slack),
            "ntfy": (await s.get("ntfy_url"), self._send_ntfy),
            "gotify": (await s.get("gotify_url"), self._send_gotify),
            "generic": (await s.get("generic_webhook_url"), self._send_generic),
        }
        for name, (url, sender) in senders.items():
            if not url:
                continue
            try:
                resp = await sender(str(url), event_type=event_type, severity=severity, title=title, message=message)
                results[name] = {"ok": True, "status": getattr(resp, "status_code", None)}
            except Exception as exc:  # never let one channel break the others
                self.ctx.logger.warning("notify-hub: %s send failed: %s", name, exc)
                results[name] = {"ok": False, "error": str(exc)}
        return results

    # ── Channel senders ─────────────────────────────────────────────────

    async def _send_discord(self, url: str, *, severity: str, title: str, message: str, **_: Any) -> Any:
        emoji = {"info": "ℹ️", "warning": "⚠️", "error": "🔴", "critical": "🚨"}.get(severity, "•")
        return await self.ctx.http.post(url, json={"content": f"{emoji} **{title}**\n{message}"})

    async def _send_slack(self, url: str, *, severity: str, title: str, message: str, **_: Any) -> Any:
        return await self.ctx.http.post(url, json={"text": f"*{title}* ({severity})\n{message}"})

    async def _send_ntfy(self, url: str, *, severity: str, title: str, message: str, **_: Any) -> Any:
        # ntfy: POST the body to the topic URL; Title/Priority via headers
        # (Authorization is blocked by the SDK — use a public/tokenless topic
        # or an unguessable topic name).
        prio = {"info": "2", "warning": "3", "error": "4", "critical": "5"}.get(severity, "3")
        return await self.ctx.http.post(url, data=message, headers={"Title": title, "Priority": prio})

    async def _send_gotify(self, url: str, *, severity: str, title: str, message: str, **_: Any) -> Any:
        # Gotify token goes in the query string (Authorization header is blocked).
        token = await self.ctx.settings.get("gotify_token", "")
        prio = {"info": 2, "warning": 5, "error": 8, "critical": 10}.get(severity, 5)
        endpoint = f"{url.rstrip('/')}/message"
        return await self.ctx.http.post(
            endpoint, params={"token": token}, json={"title": title, "message": message, "priority": prio}
        )

    async def _send_generic(self, url: str, *, event_type: str, severity: str, title: str, message: str) -> Any:
        return await self.ctx.http.post(
            url, json={"event_type": event_type, "severity": severity, "title": title, "message": message}
        )

    # ── REST API ────────────────────────────────────────────────────────

    def get_router(self) -> APIRouter:
        router = APIRouter()

        @router.get("/")
        async def status():
            """GET /api/v1/notify-hub/ — plugin status + configured channels."""
            if not self.ctx:
                return {"plugin": "notify-hub", "status": "not_started"}
            return {
                "plugin": "notify-hub",
                "status": "running",
                "enabled": await self.ctx.settings.get("enabled", True),
                "min_severity": await self.ctx.settings.get("min_severity", "warning"),
                "channels_configured": await self._configured_channels(),
            }

        @router.post("/test")
        async def send_test():
            """POST /api/v1/notify-hub/test — send a test notification to every
            configured channel and report per-channel success/failure."""
            if not self.ctx:
                return {"sent": False, "error": "Plugin not started"}
            results = await self._dispatch(
                event_type="notify-hub.test",
                severity="warning",
                title="FreeSDN test notification",
                message="If you can read this, your Notification Hub channel is working. 🎉",
            )
            return {"sent": True, "results": results}

        return router
