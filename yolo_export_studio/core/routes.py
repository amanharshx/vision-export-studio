"""Route schema — one conversion path between two formats."""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Route:
    """
    One specific conversion path from source_format to target_format
    provided by a named backend.
    """

    id: str                              # e.g. "ultralytics.pt.onnx"
    provider_id: str                     # e.g. "ultralytics"
    source_format: str                   # FormatSpec.id
    target_format: str                   # FormatSpec.id
    display_path: str                    # e.g. "best.pt → best.onnx"

    # Dependency declarations (package_name, copyable_install_hint)
    pip_deps: tuple[tuple[str, str], ...] = field(default_factory=tuple)
    # System binary deps (binary_name, install_hint)
    sys_deps: tuple[tuple[str, str], ...] = field(default_factory=tuple)

    # Platform constraint: None = any, or "linux", "linux_x86_64", "not_windows", "macos"
    platform_lock: str | None = None

    # Intermediate format IDs consumed and discarded during the chain
    intermediates: tuple[str, ...] = field(default_factory=tuple)

    # Option capability flags
    requires_gpu: bool = False
    supports_half: bool = False
    supports_int8: bool = False
    supports_dynamic: bool = False
    needs_calibration: bool = False

    # Result characteristics
    one_way: bool = False
    lossy: bool = False

    notes: str = ""
