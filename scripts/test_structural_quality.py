import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import structural_quality as quality


class StructuralQualityTests(unittest.TestCase):
    def test_parse_added_and_modified_hunks_and_ignore_deletions(self):
        diff = """@@ -1,0 +1 @@
+one
@@ -4,2 +4,3 @@
-old
+new
+more
@@ -9,2 +9,0 @@
-gone
-also gone
"""
        self.assertEqual(quality.parse_changed_ranges(diff), [(1, 1), (4, 6)])

    def test_changed_files_handles_added_modified_and_renamed(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
            subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
            subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, check=True)
            (repo / "old.py").write_text("def old():\n    return 1\n")
            (repo / "skip.xyz").write_text("changed\n")
            subprocess.run(["git", "add", "."], cwd=repo, check=True)
            subprocess.run(["git", "commit", "-qm", "base"], cwd=repo, check=True)
            base = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
            (repo / "new.py").write_text("def new():\n    return 2\n")
            (repo / "old.py").rename(repo / "renamed.py")
            (repo / "skip.xyz").write_text("changed again\n")
            subprocess.run(["git", "add", "-A"], cwd=repo, check=True)
            subprocess.run(["git", "commit", "-qm", "head"], cwd=repo, check=True)
            head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
            files = quality.changed_files(repo, base, head)
            self.assertEqual({path.name for path in files}, {"new.py", "renamed.py", "skip.xyz"})

    def test_changed_files_uses_merge_base_when_branch_is_behind(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
            subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
            subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, check=True)
            (repo / "base.py").write_text("base = 1\n")
            subprocess.run(["git", "add", "."], cwd=repo, check=True)
            subprocess.run(["git", "commit", "-qm", "base"], cwd=repo, check=True)
            base = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
            subprocess.run(["git", "checkout", "-qb", "feature"], cwd=repo, check=True)
            (repo / "feature.py").write_text("feature = 1\n")
            subprocess.run(["git", "add", "."], cwd=repo, check=True)
            subprocess.run(["git", "commit", "-qm", "feature"], cwd=repo, check=True)
            head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
            subprocess.run(["git", "checkout", "-qb", "mainline", base], cwd=repo, check=True)
            (repo / "base-only.py").write_text("base_only = 1\n")
            subprocess.run(["git", "add", "."], cwd=repo, check=True)
            subprocess.run(["git", "commit", "-qm", "base-only"], cwd=repo, check=True)
            later_base = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
            self.assertEqual({path.name for path in quality.changed_files(repo, later_base, head)}, {"feature.py"})

    def test_analyze_only_overlapping_functions_and_aggregate_deduplicate_order(self):
        functions = [
            quality.Function("z", 30, 30, 60, 11, 6),
            quality.Function("a", 2, 2, 51, 11, 6),
            quality.Function("a", 2, 2, 51, 11, 6),
            quality.Function("untouched", 80, 80, 99, 99, 1),
        ]
        findings = quality.findings_for_functions("x.py", [(1, 40)], functions)
        self.assertEqual([(f.name, f.exceeded) for f in findings], [("a", ("nloc", "complexity", "parameters")), ("z", ("nloc", "complexity", "parameters"))])

    def test_threshold_equality_clean_and_unknown_files_counted(self):
        self.assertEqual(quality.exceeded(50, 10, 5), ())
        self.assertEqual(quality.exceeded(51, 10, 5), ("nloc",))
        self.assertEqual(quality.supported_extension("x.xyz"), False)
        self.assertTrue(quality.in_structural_scope("src/features/export.ts"))
        self.assertTrue(quality.in_structural_scope("scripts/check.py"))
        self.assertFalse(quality.in_structural_scope(".github/workflows/ci.yml"))
        self.assertFalse(quality.in_structural_scope("src/assets/icon.json"))

    def test_annotation_escapes_properties_and_message(self):
        output = quality.annotation("bad%name\n", "x,y:file", 2, 4, "fn:one")
        self.assertEqual(output, "::warning file=x%2Cy%3Afile,line=2,endLine=4,title=Structural quality::bad%25name%0A [fn:one]")

    def test_summaries_include_marker_and_wording(self):
        finding = quality.Finding("x.py", "fn", 2, 3, ("nloc",), 51, 1, 1)
        results = [quality.FileResult("clean.py", True, True, ()), quality.FileResult("x.py", True, True, (finding,)), quality.FileResult("skip.xyz", False, False, ())]
        text = quality.summary(results)
        self.assertIn("⚠️ 1 needs attention · ✅ 1 clean · ➖ 1 not analyzed", text)
        self.assertIn("<summary>⚠️ Needs attention — 1 file</summary>", text)
        self.assertIn("- `x.py`\n  - `fn` · lines 2–3", text)
        self.assertIn("Function length: **51 NLOC** · limit: **50**", text)
        self.assertIn("- `skip.xyz` — unsupported file type", text)
        self.assertNotIn("changed functions", text)
        self.assertIn("<!-- structural-code-quality -->", text)
        commit_text = quality.summary(results, "1b680b590bee1a0b2d863ed5cb43f40812af6b13", "amanharshx/vision-export-studio")
        self.assertIn("Results for commit [`1b680b5`](https://github.com/amanharshx/vision-export-studio/commit/1b680b590bee1a0b2d863ed5cb43f40812af6b13)", commit_text)

    def test_threshold_findings_exit_zero(self):
        finding = quality.Finding("x.py", "fn", 2, 3, ("nloc",), 51, 1, 1)
        with tempfile.NamedTemporaryFile() as summary:
            with patch.object(quality, "run_analysis", return_value=[quality.FileResult("x.py", True, True, (finding,))]):
                self.assertEqual(quality.main(["--base", "base", "--head", "head", "--summary", summary.name]), 0)


if __name__ == "__main__":
    unittest.main()
