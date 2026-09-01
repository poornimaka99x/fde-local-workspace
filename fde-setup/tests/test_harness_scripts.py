import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "fde-toolkit" / "plugins" / "fde-core"
SHARED = ROOT / "claude-shared"
CONTEXT_BUDGET = PLUGIN / "scripts" / "context_budget.py"
CONFIG_AUDIT = PLUGIN / "scripts" / "audit_agent_config.py"


class HarnessScriptTest(unittest.TestCase):
    def run_script(self, script, *args, expected=0):
        result = subprocess.run(
            ["python3", str(script), *map(str, args)],
            text=True,
            capture_output=True,
        )
        self.assertEqual(result.returncode, expected,
                         msg=f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}")
        return result

    def test_context_budget_inventory_is_machine_readable(self):
        result = self.run_script(
            CONTEXT_BUDGET, "--plugin-root", PLUGIN, "--repo", ROOT, "--json",
        )
        report = json.loads(result.stdout)
        self.assertGreaterEqual(report["totals"]["skill"]["count"], 20)
        self.assertGreaterEqual(report["totals"]["agent"]["count"], 20)
        self.assertGreater(report["estimatedStaticTokens"], 0)
        self.assertIn("context7", report["mcpServers"])

    def test_agent_config_audit_passes_and_detects_bypass(self):
        clean = self.run_script(
            CONFIG_AUDIT, "--plugin-root", PLUGIN, "--shared-root", SHARED, "--json",
        )
        self.assertEqual(json.loads(clean.stdout)["errors"], [])

        with tempfile.TemporaryDirectory() as tmp:
            copied = Path(tmp) / "fde-core"
            shutil.copytree(PLUGIN, copied)
            (copied / "unsafe.txt").write_text("codex exec --yolo\n")
            unsafe = self.run_script(
                copied / "scripts" / "audit_agent_config.py",
                "--plugin-root", copied, "--shared-root", SHARED, "--json",
                expected=1,
            )
            errors = json.loads(unsafe.stdout)["errors"]
            self.assertTrue(any("sandbox-bypass flag" in item for item in errors))


if __name__ == "__main__":
    unittest.main()
