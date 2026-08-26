"""Diff-scoped structural quality coordinator."""

import argparse
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

SUPPORTED = {".py", ".rs", ".js", ".ts", ".tsx", ".jsx"}
THRESHOLDS = (("nloc", 50), ("complexity", 10), ("parameters", 5))
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
    labels = {"nloc": f"{finding.nloc} NLOC", "complexity": f"complexity {finding.complexity}", "parameters": f"{finding.parameters} parameters"}
    return ", ".join(labels[name] for name in finding.exceeded)


def summary(analyzed, files, findings, skipped=0):
    lines = ["## Structural code quality", ""]
    if analyzed == 0:
        lines.append("✅ No supported changed functions analyzed.")
    elif findings:
        count = len(findings)
        lines.extend([f"Analyzed {analyzed} changed function{'s' if analyzed != 1 else ''} across {files} file{'s' if files != 1 else ''}.", "", f"⚠️ {count} structural warning{'s' if count != 1 else ''}", ""])
        lines.extend(f"- `{item.file}:{item.start_line}` — `{item.name}`: {metric_text(item)}" for item in findings)
    else:
        lines.append(f"✅ Analyzed {analyzed} changed function{'s' if analyzed != 1 else ''}. No structural threshold findings.")
    lines.extend(["", "Informational only. This check does not block merging.", "", MARKER, ""])
    if skipped:
        lines.insert(-2, f"Skipped {skipped} unsupported changed file{'s' if skipped != 1 else ''}.")
    return "\n".join(lines)


def lizard_functions(path):
    import lizard
    return [Function(item.name, item.start_line, item.end_line, item.nloc, item.cyclomatic_complexity, item.parameter_count) for item in lizard.analyze_file(str(path)).function_list]


def run_analysis(repo, base, head):
    comparison_base = merge_base(repo, base, head)
    files = _changed_files(repo, comparison_base, head)
    findings, analyzed, skipped = [], 0, 0
    for relative in files:
        if not supported_extension(relative):
            skipped += 1
            continue
        diff = subprocess.run(["git", "diff", "--unified=0", "--no-color", comparison_base, head, "--", str(relative)], cwd=repo, check=True, capture_output=True, text=True).stdout
        functions = lizard_functions(repo / relative)
        ranges = parse_changed_ranges(diff)
        analyzed += sum(1 for function in functions if any(function.start_line <= end and function.end_line >= start for start, end in ranges))
        findings.extend(findings_for_functions(str(relative), ranges, functions))
    unique = {(item.file, item.name, item.start_line): item for item in findings}
    return analyzed, len(files) - skipped, skipped, sorted(unique.values(), key=lambda item: (-len(item.exceeded), item.file, item.start_line, item.name))


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True)
    parser.add_argument("--head", required=True)
    parser.add_argument("--summary", required=True)
    args = parser.parse_args(argv)
    try:
        analyzed, files, skipped, findings = run_analysis(Path.cwd(), args.base, args.head)
        Path(args.summary).write_text(summary(analyzed, files, findings, skipped), encoding="utf-8")
        for finding in findings:
            print(annotation(metric_text(finding), finding.file, finding.start_line, finding.end_line, finding.name))
        return 0
    except (OSError, subprocess.CalledProcessError, ImportError, ValueError) as error:
        print(f"structural quality analyzer failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
