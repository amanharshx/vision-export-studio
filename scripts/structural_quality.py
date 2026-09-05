"""Diff-scoped structural quality coordinator."""

import argparse
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

SUPPORTED = {".py", ".rs", ".js", ".ts", ".tsx", ".jsx"}
STRUCTURAL_ROOTS = (("src/", {".ts", ".tsx", ".js", ".jsx"}), ("src-tauri/src/", {".rs"}), ("src-tauri/python/", {".py"}), ("scripts/", {".py"}))
THRESHOLDS = (("nloc", 110), ("complexity", 15), ("parameters", 5))
LIMITS = dict(THRESHOLDS)
MARKER = "<!-- structural-code-quality -->"


@dataclass(frozen=True)
class Function:
    name: str
    start_line: int
    end_line: int
    nloc: int
    complexity: int
    parameters: int


@dataclass(frozen=True)
class Finding:
    file: str
    name: str
    start_line: int
    end_line: int
    exceeded: tuple
    nloc: int
    complexity: int
    parameters: int


@dataclass(frozen=True)
class FileResult:
    file: str
    supported: bool
    analyzed: bool
    findings: tuple


def parse_changed_ranges(diff):
    ranges = []
    for line in diff.splitlines():
        if not line.startswith("@@"):
            continue
        new = line.split("+")[1].split(" ")[0].split("@@")[0]
        parts = new.split(",")
        start = int(parts[0])
        count = int(parts[1]) if len(parts) == 2 else 1
        if count:
            ranges.append((start, start + count - 1))
    return ranges


def merge_base(repo, base, head):
    result = subprocess.run(["git", "merge-base", base, head], cwd=repo, check=True, capture_output=True, text=True)
    return result.stdout.strip()


def _changed_files(repo, base, head):
    result = subprocess.run(["git", "diff", "--name-only", "--diff-filter=ACMR", "-z", base, head], cwd=repo, check=True, capture_output=True)
    return [Path(name) for name in result.stdout.decode().split("\0") if name]


def changed_files(repo, base, head):
    return _changed_files(repo, merge_base(repo, base, head), head)


def supported_extension(path):
    return Path(path).suffix.lower() in SUPPORTED


def in_structural_scope(path):
    normalized = str(path).replace("\\", "/")
    suffix = Path(normalized).suffix.lower()
    return any(normalized.startswith(root) and suffix in extensions for root, extensions in STRUCTURAL_ROOTS)


def exceeded(nloc, complexity, parameters):
    values = {"nloc": nloc, "complexity": complexity, "parameters": parameters}
    return tuple(name for name, threshold in THRESHOLDS if values[name] > threshold)


def findings_for_functions(file, ranges, functions):
    seen = set()
    findings = []
    for function in functions:
        if not any(function.start_line <= end and function.end_line >= start for start, end in ranges):
            continue
        key = (file, function.name, function.start_line)
        metrics = exceeded(function.nloc, function.complexity, function.parameters)
        if key in seen or not metrics:
            continue
        seen.add(key)
        findings.append(Finding(file, function.name, function.start_line, function.end_line, metrics, function.nloc, function.complexity, function.parameters))
    return sorted(findings, key=lambda item: (-len(item.exceeded), item.file, item.start_line, item.name))


def annotation(name, file, start, end, function):
    def escape_property(value):
        return str(value).replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A").replace(":", "%3A").replace(",", "%2C")
    def escape_message(value):
        return str(value).replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
    return f"::warning file={escape_property(file)},line={start},endLine={end},title=Structural quality::{escape_message(name)} [{escape_message(function)}]"


def metric_text(finding):
    labels = {
        "nloc": f"Function length: **{finding.nloc} NLOC** · limit: **{LIMITS['nloc']}**",
        "complexity": f"Cyclomatic complexity: **{finding.complexity}** · limit: **{LIMITS['complexity']}**",
        "parameters": f"Parameter count: **{finding.parameters}** · limit: **{LIMITS['parameters']}**",
    }
    return [labels[name] for name in finding.exceeded]


def metric_annotation_text(finding):
    labels = {"nloc": f"{finding.nloc} NLOC, limit {LIMITS['nloc']}", "complexity": f"complexity {finding.complexity}, limit {LIMITS['complexity']}", "parameters": f"{finding.parameters} parameters, limit {LIMITS['parameters']}"}
    return ", ".join(labels[name] for name in finding.exceeded)


def classify_results(results):
    return ([result for result in results if result.findings], [result for result in results if result.supported and result.analyzed and not result.findings], [result for result in results if not result.supported or not result.analyzed])


def render_commit(commit_sha, repository):
    if not commit_sha:
        return []
    short_sha = commit_sha[:7]
    target = f"https://github.com/{repository}/commit/{commit_sha}" if repository else None
    text = f"Results for commit [`{short_sha}`]({target})" if target else f"Results for commit `{short_sha}`"
    return [text, ""]


def render_warning_group(results):
    lines = ["<details open>", f"<summary>⚠️ Needs attention — {len(results)} file{'s' if len(results) != 1 else ''}</summary>", ""]
    for result in results:
        lines.append(f"- `{result.file}`")
        for finding in result.findings:
            lines.append(f"  - `{finding.name}` · lines {finding.start_line}–{finding.end_line}")
            lines.extend(f"    - {metric}" for metric in metric_text(finding))
    return lines + ["", "</details>", ""]


def render_clean_group(results):
    return ["<details>", f"<summary>✅ Clean — {len(results)} file{'s' if len(results) != 1 else ''}</summary>", ""] + [f"- `{result.file}`" for result in results] + ["", "</details>", ""]


def render_not_analyzed_group(results):
    lines = ["<details>", f"<summary>➖ Not analyzed — {len(results)} file{'s' if len(results) != 1 else ''}</summary>", ""]
    for result in results:
        reason = "unsupported file type" if not result.supported else "no changed function to analyze"
        lines.append(f"- `{result.file}` — {reason}")
    return lines + ["", "</details>", ""]


def render_groups(warning_results, clean_results, not_analyzed_results):
    lines = []
    if warning_results:
        lines.extend(render_warning_group(warning_results))
    if clean_results:
        lines.extend(render_clean_group(clean_results))
    if not_analyzed_results:
        lines.extend(render_not_analyzed_group(not_analyzed_results))
    return lines


def summary(results, commit_sha=None, repository=None):
    warning_results, clean_results, not_analyzed_results = classify_results(results)
    lines = ["## Structural code quality", ""] + render_commit(commit_sha, repository)
    lines.extend(render_groups(warning_results, clean_results, not_analyzed_results))
    lines.extend(["_Informational only — checks structural code quality in this PR. Does not block merging._", "", MARKER, ""])
    return "\n".join(lines)


def lizard_functions(path):
    import lizard
    return [Function(item.name, item.start_line, item.end_line, item.nloc, item.cyclomatic_complexity, item.parameter_count) for item in lizard.analyze_file(str(path)).function_list]


def run_analysis(repo, base, head):
    comparison_base = merge_base(repo, base, head)
    files = [path for path in _changed_files(repo, comparison_base, head) if in_structural_scope(path)]
    results = []
    for relative in files:
        if not in_structural_scope(relative) or not supported_extension(relative):
            results.append(FileResult(str(relative), False, False, ()))
            continue
        diff = subprocess.run(["git", "diff", "--unified=0", "--no-color", comparison_base, head, "--", str(relative)], cwd=repo, check=True, capture_output=True, text=True).stdout
        functions = lizard_functions(repo / relative)
        ranges = parse_changed_ranges(diff)
        analyzed = any(function.start_line <= end and function.end_line >= start for function in functions for start, end in ranges)
        results.append(FileResult(str(relative), True, analyzed, tuple(findings_for_functions(str(relative), ranges, functions))))
    return sorted(results, key=lambda item: item.file)


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True)
    parser.add_argument("--head", required=True)
    parser.add_argument("--summary", required=True)
    args = parser.parse_args(argv)
    try:
        results = run_analysis(Path.cwd(), args.base, args.head)
        Path(args.summary).write_text(summary(results, os.environ.get("HEAD_SHA"), os.environ.get("GITHUB_REPOSITORY")), encoding="utf-8")
        for result in results:
            for finding in result.findings:
                print(annotation(metric_annotation_text(finding), finding.file, finding.start_line, finding.end_line, finding.name))
        return 0
    except (OSError, subprocess.CalledProcessError, ImportError, ValueError) as error:
        print(f"structural quality analyzer failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
