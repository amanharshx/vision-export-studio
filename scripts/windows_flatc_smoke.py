"""Exercise flatc discovery and execution in an unactivated Windows venv."""

from __future__ import annotations

import importlib.metadata
import importlib.resources
import os
import shutil
import subprocess
import sys
from pathlib import Path


def candidate(path) -> str | None:
    if path is None:
        return None
    path = Path(path)
    if path.is_file() and path.parent.name.lower() != "scripts":
        return str(path)
    return None


def resolve_flatc() -> str | None:
    try:
        package = importlib.resources.files("executorch.data.bin")
        for name in ("flatc", "flatc.exe"):
            found = candidate(package.joinpath(name))
            if found:
                return found
    except Exception:
        pass
    for distribution, suffixes in (
        ("executorch", ("/data/bin/flatc", "/data/bin/flatc.exe")),
        ("flatc", ("/bin/flatc", "/bin/flatc.exe")),
    ):
        try:
            dist = importlib.metadata.distribution(distribution)
        except importlib.metadata.PackageNotFoundError:
            continue
        for file in dist.files or ():
            name = str(file).replace("\\", "/").lower()
            if name.endswith(suffixes):
                found = candidate(dist.locate_file(file))
                if found:
                    return found
    for name in ("flatc", "flatc.exe"):
        found = candidate(shutil.which(name))
        if found:
            return found
    return None


def run(path: str | None) -> bool:
    if not path:
        return False
    proc = subprocess.run([path, "--version"], capture_output=True, text=True, check=False)
    print(f"resolved={path!r} exit={proc.returncode}")
    print((proc.stdout + proc.stderr).strip())
    return proc.returncode == 0


def remove_bundled_and_wrapper() -> None:
    dist = importlib.metadata.distribution("executorch")
    for file in dist.files or ():
        name = str(file).replace("\\", "/").lower()
        if name.endswith(("/data/bin/flatc", "/data/bin/flatc.exe")):
            path = Path(dist.locate_file(file))
            if path.is_file():
                path.unlink()
    for path in Path(sys.executable).resolve().parent.glob("flatc*"):
        if path.is_file():
            path.unlink()


def phase(label: str) -> bool:
    print(f"\n========== {label} ==========")
    print(f"PATH={os.environ.get('PATH', '')}")
    return run(resolve_flatc())


def main() -> int:
    if os.environ.get("VIRTUAL_ENV"):
        raise SystemExit("VIRTUAL_ENV must be unset")
    ok_a = phase("A bundled-present")
    remove_bundled_and_wrapper()
    ok_b = phase("B missing")
    pip = subprocess.run(
        [sys.executable, "-m", "pip", "install", "--pre", "flatc"], check=False
    )
    ok_c = phase("C installed-wheel") if pip.returncode == 0 else False
    print(f"\nA bundled execution: {ok_a}")
    print(f"B missing execution: {ok_b} (expected False)")
    print(f"C installed-wheel execution: {ok_c}")
    return 0 if (ok_a, ok_b, ok_c) == (True, False, True) else 1


if __name__ == "__main__":
    raise SystemExit(main())
