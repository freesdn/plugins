# SPDX-License-Identifier: MIT
# Copyright (C) 2024-2026 FreeSDN
"""Make the documented bare ``pytest tests`` command import the plugin root."""

import sys
from pathlib import Path

_PLUGIN_ROOT = str(Path(__file__).resolve().parent.parent)
if _PLUGIN_ROOT not in sys.path:
    sys.path.insert(0, _PLUGIN_ROOT)
