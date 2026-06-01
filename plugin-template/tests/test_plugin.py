"""
Tests for the plugin, using the SDK's mock context.

The SDK ships in-memory mocks of every context surface, so these tests run
without the FreeSDN runtime. Run them with:

    pip install "freesdn-sdk[dev]"
    pytest
"""

from __future__ import annotations

import pytest

from freesdn_sdk.testing import create_test_context

from plugin import MyPlugin


@pytest.mark.asyncio
async def test_on_start_alerts_on_offline_devices():
    ctx = create_test_context(
        plugin_id="my-plugin",
        devices=[
            {"id": "11111111-1111-1111-1111-111111111111",
             "name": "Switch-1", "status": "offline"},
            {"id": "22222222-2222-2222-2222-222222222222",
             "name": "Switch-2", "status": "online"},
        ],
        settings={"example_setting": "hi"},
    )

    plugin = MyPlugin()
    plugin.ctx = ctx
    await plugin.on_start(ctx.organization_id)

    # One offline device -> one alert, and a startup_complete event.
    assert len(ctx.alerts.alerts) == 1
    assert ctx.alerts.alerts[0]["severity"] == "warning"
    ctx.events.assert_emitted("startup_complete", offline_count=1)


@pytest.mark.asyncio
async def test_check_endpoint_counts_offline():
    ctx = create_test_context(
        plugin_id="my-plugin",
        devices=[{"id": "d1", "name": "AP-1", "status": "offline"}],
    )

    plugin = MyPlugin()
    plugin.ctx = ctx

    router = plugin.get_router()
    check = next(
        r.endpoint for r in router.routes if getattr(r, "path", "") == "/check"
    )
    result = await check()

    assert result == {"checked": True, "offline_count": 1}
    ctx.events.assert_emitted("check_complete", offline_count=1)
