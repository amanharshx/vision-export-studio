#!/usr/bin/env python3
"""Summarize H9 native GitHub Actions artifacts without changing evidence."""

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path


EXPECTED_STATES = {
    "macos-x86_64": {tag: ["fresh"] for tag in ("py310", "py311", "py312", "py313")},
    "linux-x86_64": {
        tag: ["fresh", "onnxpop"] for tag in ("py310", "py311", "py312", "py313")
    },
    "windows-x86_64": {
        tag: ["fresh", "onnxpop"] for tag in ("py310", "py311", "py312", "py313")
    },
    "macos-arm64": {
        tag: ["onnxpop"] for tag in ("py310", "py311", "py313")
    },
}
EXPECTED_STEP4 = ("linux-x86_64", "windows-x86_64")
EXPECTED_RESOLUTION_COUNT = sum(
    len(states) for tags in EXPECTED_STATES.values() for states in tags.values())


def cell_name(target, tag, state):
    return f"h9-resolution-{target}-{tag}-{state}"


def load_json(path):
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def esc(value):
    return str(value).replace("|", "\\|").replace("\n", " ")


def main(argv=None):
    parser = argparse.ArgumentParser(description="summarize native H9 CI artifacts")
    parser.add_argument("--artifacts", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args(argv)

    summaries = {}
    missing = []
    malformed = []
    for target, tags in EXPECTED_STATES.items():
        for tag, states in tags.items():
            for state in states:
                root = args.artifacts / cell_name(target, tag, state) / "reports"
                suffix = "_onnxpop" if state == "onnxpop" else ""
                path = root / f"summary_{tag}{suffix}.json"
                key = (target, tag, state)
                if not path.exists():
                    missing.append(str(path.relative_to(args.artifacts)))
                    continue
                try:
                    data = load_json(path)
                    if (data.get("target"), data.get("tag"), data.get("stack_state")) != key:
                        raise ValueError("identity fields do not match artifact path")
                    if not isinstance(data.get("rows"), list):
                        raise ValueError("rows is not a list")
                    summaries[key] = data
                except (OSError, ValueError, AttributeError, TypeError) as exc:
                    malformed.append(f"{path.relative_to(args.artifacts)}: {exc}")

    step4 = {}
    for target in EXPECTED_STEP4:
        path = args.artifacts / f"h9-step4-{target}" / "reports" / "step4-summary.json"
        if not path.exists():
            missing.append(str(path.relative_to(args.artifacts)))
            continue
        try:
            data = load_json(path)
            if data.get("target") != target:
                raise ValueError("target does not match artifact path")
            step4[target] = data
        except (OSError, ValueError, AttributeError, TypeError) as exc:
            malformed.append(f"{path.relative_to(args.artifacts)}: {exc}")

    lines = [
        "# H9 native wheel-policy CI summary",
        "",
        f"Coverage: **{len(summaries)}/{EXPECTED_RESOLUTION_COUNT} resolution states** and "
        f"**{len(step4)}/2 decisive real-install targets**.",
        "",
        "## Resolution coverage",
        "",
        "| Target | Python | Stack | Rows | Identical | Divergent | Binary failure | "
        "Base failure | Timeout | Unverified | Gated |",
        "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    findings = []
    source_builds = defaultdict(set)
    for key, data in sorted(summaries.items()):
        counts = Counter(row.get("verdict", "missing-verdict") for row in data["rows"])
        target, tag, state = key
        lines.append(
            f"| {target} | {tag[2]}.{tag[3:]} | {state} | {len(data['rows'])} | "
            f"{counts['identical']} | {counts['divergent']} | {counts['binary failure']} | "
            f"{counts['base failure']} | {counts['timeout/non-convergence']} | "
            f"{counts['unverified']} | "
            f"{counts['gated-skipped']} |"
        )
        for row in data["rows"]:
            verdict = row.get("verdict")
            if verdict not in ("identical", "gated-skipped"):
                findings.append((target, tag, state, row.get("group"), verdict,
                                 row.get("ord_rc"), row.get("bin_rc")))
            sdists = row.get("sdists_in_ordinary_delta")
            if isinstance(sdists, list):
                source_builds[(target, tag, state, row.get("group"))].update(sdists)

    lines.extend([
        "",
        "## Non-identical or unresolved outcomes",
        "",
        "| Target | Python | Stack | Group | Verdict | Ordinary rc | Binary rc |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ])
    if findings:
        for finding in findings:
            target, tag, state, group, verdict, ord_rc, bin_rc = finding
            lines.append(f"| {esc(target)} | {tag[2]}.{tag[3:]} | {esc(state)} | "
                         f"{esc(group)} | {esc(verdict)} | {esc(ord_rc)} | {esc(bin_rc)} |")
    else:
        lines.append("| — | — | — | — | none | — | — |")

    lines.extend([
        "",
        "## Ordinary-policy source archives selected by pip reports",
        "",
    ])
    if source_builds:
        for key, packages in sorted(source_builds.items()):
            target, tag, state, group = key
            lines.append(f"- `{target}` {tag[2]}.{tag[3:]} {state} `{group}`: "
                         + ", ".join(f"`{package}`" for package in sorted(packages)))
    else:
        lines.append("- None reported in the completed resolution states.")

    lines.extend([
        "",
        "## Decisive Python 3.12 real installs",
        "",
        "| Target | Ordinary stable | Ordinary flatc | pip check | Probe | "
        "Binary stable | Ordinary freeze | Binary freeze |",
        "| --- | --- | --- | --- | --- | --- | ---: | ---: |",
    ])
    for target, data in sorted(step4.items()):
        ordinary = data.get("ordinary", {})
        binary = data.get("binary", {})
        lines.append(
            f"| {target} | {esc(ordinary.get('stable_rc'))} | "
            f"{esc(ordinary.get('pre_rc'))} | {esc(ordinary.get('check_rc'))} | "
            f"{esc(ordinary.get('probe_rc'))} | {esc(binary.get('stable_rc'))} | "
            f"{esc(ordinary.get('freeze_count'))} | {esc(binary.get('freeze_count'))} |"
        )
    if not step4:
        lines.append("| — | — | — | — | — | — | — | — |")

    lines.extend(["", "## Artifact integrity", ""])
    if not missing and not malformed:
        lines.append("All expected summary artifacts were present and structurally valid.")
    else:
        for path in missing:
            lines.append(f"- Missing: `{path}`")
        for detail in malformed:
            lines.append(f"- Malformed: `{esc(detail)}`")

    args.out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {args.out}: {len(summaries)}/{EXPECTED_RESOLUTION_COUNT} "
          "resolution states, "
          f"{len(step4)}/2 real-install targets, {len(missing)} missing, "
          f"{len(malformed)} malformed")
    if missing or malformed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
