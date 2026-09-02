"""Windows ExecuTorch flatc smoke: discovery vs actual execution.

Invoke only the venv interpreter. Never activate the venv.
"""

from __future__ import annotations

import importlib.metadata
import importlib.resources
import os
import shutil
import subprocess
import sys
from pathlib import Path


def scripts_dir() -> Path:
    return Path(sys.executable).resolve().parent


def inherited_path() -> str:
    return os.environ.get("PATH", "")


def which_plain(name: str) -> str | None:
    return shutil.which(name)


def which_scripts(name: str) -> str | None:
    selected = str(scripts_dir()) + os.pathsep + inherited_path()
    return shutil.which(name, path=selected)


def record_flatc_files() -> list[str]:
    hits: list[str] = []
    try:
        dist = importlib.metadata.distribution("executorch")
    except importlib.metadata.PackageNotFoundError:
        return hits
    for file in dist.files or []:
        name = str(file).replace("\\", "/")
        if "flatc" in name.lower() and "data/bin" in name.lower():
            located = Path(dist.locate_file(file))
            hits.append(f"{name} exists={located.is_file()} path={located}")
    return hits


def replicate_get_flatc_path() -> str:
    for package, resource_name in (
        ("executorch.exir._serialize", "flatbuffers-flatc"),
        ("executorch.data.bin", "flatc"),
    ):
        try:
            resource = importlib.resources.files(package).joinpath(resource_name)
        except ModuleNotFoundError:
            continue
        if resource.is_file():
            return str(resource)
    return os.getenv("FLATC_EXECUTABLE", "flatc")


def get_flatc_path() -> tuple[str, str]:
    try:
        from executorch.exir._serialize._flatbuffer import _get_flatc_path

        return _get_flatc_path(), "executorch.exir._serialize._flatbuffer._get_flatc_path"
    except Exception as err:
        return replicate_get_flatc_path(), f"replicated lookup after import failed: {err!r}"


def run_version(command: str) -> tuple[int, str]:
    try:
        proc = subprocess.run(
            [command, "--version"],
            check=False,
            capture_output=True,
            text=True,
        )
        output = ((proc.stdout or "") + (proc.stderr or "")).strip()
        return proc.returncode, output
    except OSError as err:
        return -1, f"{type(err).__name__}: {err}"


def print_section(title: str) -> None:
    print(f"\n========== {title} ==========", flush=True)


def report(phase: str) -> bool:
    print_section(f"PHASE {phase}")
    print(f"sys.executable={sys.executable}")
    print(f"VIRTUAL_ENV={os.environ.get('VIRTUAL_ENV', '')!r}")
    print(f"Scripts={scripts_dir()}")
    print(f"inherited PATH={inherited_path()}")
    print("RECORD data/bin flatc files:")
    files = record_flatc_files()
    if not files:
        print("  (none)")
    for row in files:
        print(f"  {row}")
    path, source = get_flatc_path()
    print(f"_get_flatc_path()={path!r} via {source}")
    print(f"which(flatc)={which_plain('flatc')!r}")
    print(f"which(flatc.exe)={which_plain('flatc.exe')!r}")
    print(f"which(flatc, Scripts+PATH)={which_scripts('flatc')!r}")
    print(f"which(flatc.exe, Scripts+PATH)={which_scripts('flatc.exe')!r}")
    code, output = run_version(path)
    print(f"subprocess.run([{path!r}, '--version']) exit={code}")
    print(output)
    return code == 0


def remove_bundled_and_wrapper() -> None:
    print_section("REMOVE bundled compiler + console wrapper")
    removed: list[str] = []
    try:
        dist = importlib.metadata.distribution("executorch")
        for file in dist.files or []:
            name = str(file).replace("\\", "/").lower()
            if name.endswith(("/data/bin/flatc", "/data/bin/flatc.exe")):
                path = Path(dist.locate_file(file))
                if path.is_file():
                    path.unlink()
                    removed.append(str(path))
    except importlib.metadata.PackageNotFoundError:
        pass
    for path in scripts_dir().glob("flatc*"):
        if path.is_file():
            path.unlink()
            removed.append(str(path))
    if removed:
        for row in removed:
            print(f"  removed {row}")
    else:
        print("  (nothing found)")


def main() -> int:
    print_section("ENVIRONMENT")
    print(f"python={sys.version}")
    print(f"executable={sys.executable}")
    print(f"platform={sys.platform}")
    if os.environ.get("VIRTUAL_ENV"):
        print("WARNING: VIRTUAL_ENV is set; this smoke test should not activate the venv")

    ok_a = report("A bundled-present")
    remove_bundled_and_wrapper()
    ok_b = report("B bundled+wrapper removed")

    print_section("INSTALL python -m pip install --pre flatc")
    pip = subprocess.run(
        [sys.executable, "-m", "pip", "install", "--pre", "flatc"],
        check=False,
    )
    print(f"pip exit={pip.returncode}")
    ok_c = False
    if pip.returncode == 0:
        ok_c = report("C after --pre flatc, inherited PATH, venv not activated")

    print_section("SUMMARY")
    print(f"A bundled execution ok={ok_a}")
    print(f"B missing execution ok={ok_b} (expected False)")
    print(f"C pip-flatc execution on inherited PATH ok={ok_c}")
    print(
        "False ready if A discovery would pass (RECORD/Scripts which) but A execution is False."
    )
    print(
        "Install hint does not fix export if C Scripts+PATH which is set and C execution is False."
    )
    return 0 if pip.returncode == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
