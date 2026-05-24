"""Read-only dependency checker primitives."""
from __future__ import annotations

import importlib.metadata
import importlib.util
import platform
import shutil
from dataclasses import dataclass
from typing import Literal


CheckStatus = Literal[
    "ready",
    "missing_package",
    "missing_binary",
    "version_incompatible",
    "platform_unsupported",
    "gpu_unavailable",
    "calibration_required",
    "warning",
]


@dataclass
class CheckResult:
    """Result of one preflight check."""

    item: str                    # Package or binary name
    status: CheckStatus
    reason: str = ""             # Human-readable explanation
    install_hint: str = ""       # Copyable install command
    docs_url: str = ""           # Optional documentation link

    @property
    def ok(self) -> bool:
        return self.status in ("ready", "warning")


# ---------------------------------------------------------------------------
# Low-level check helpers (read-only, no ML imports)
# ---------------------------------------------------------------------------

def check_package(
    package: str,
    install_hint: str,
    min_version: str | None = None,
    docs_url: str = "",
) -> CheckResult:
    """
    Check whether a Python package is importable and optionally meets
    a minimum version requirement.
    Uses importlib.util.find_spec (no import) and importlib.metadata.version.
    """
    spec = importlib.util.find_spec(package)
    if spec is None:
        return CheckResult(
            item=package,
            status="missing_package",
            reason=f"Package '{package}' is not installed.",
            install_hint=install_hint,
            docs_url=docs_url,
        )

    if min_version is not None:
        try:
            installed = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            return CheckResult(item=package, status="ready")

        from packaging.version import Version
        if Version(installed) < Version(min_version):
            return CheckResult(
                item=package,
                status="version_incompatible",
                reason=f"'{package}' {installed} found; {min_version}+ required.",
                install_hint=install_hint,
                docs_url=docs_url,
            )

    return CheckResult(item=package, status="ready")


def check_binary(
    binary: str,
    install_hint: str,
    docs_url: str = "",
) -> CheckResult:
    """Check whether a system binary is on PATH using shutil.which."""
    if shutil.which(binary) is None:
        return CheckResult(
            item=binary,
            status="missing_binary",
            reason=f"System binary '{binary}' not found on PATH.",
            install_hint=install_hint,
            docs_url=docs_url,
        )
    return CheckResult(item=binary, status="ready")


def check_platform(required: str) -> CheckResult:
    """
    Check platform constraint.
    required: "linux", "linux_x86_64", "not_windows", "macos"
    """
    system = platform.system().lower()
    machine = platform.machine().lower()

    match required:
        case "linux":
            ok = system == "linux"
        case "linux_x86_64":
            ok = system == "linux" and machine in ("x86_64", "amd64")
        case "not_windows":
            ok = system != "windows"
        case "macos":
            ok = system == "darwin"
        case _:
            ok = True

    if not ok:
        return CheckResult(
            item="platform",
            status="platform_unsupported",
            reason=f"This route requires platform '{required}'. Detected: {platform.system()} {platform.machine()}.",
        )
    return CheckResult(item="platform", status="ready")
