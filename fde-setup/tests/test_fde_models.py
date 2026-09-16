"""Live provider catalogues are the availability boundary for auto routing."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "claude-shared" / "lib"))
import fde_models  # noqa: E402


class ModelDiscoveryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.policy = json.loads(
            (ROOT / "claude-shared/config/routing-policy.json").read_text(encoding="utf-8"))
        self.codex = self.root / "codex"
        self.agy = self.root / "agy"
        self.codex.write_text("""#!/bin/sh
printf '%s\\n' '{"models":[{"slug":"gpt-6-astra","display_name":"GPT-6 Astra","visibility":"list","priority":1,"supported_reasoning_levels":[{"effort":"high"},{"effort":"max"}]},{"slug":"gpt-5.6-luna","display_name":"GPT-5.6-Luna","visibility":"list","priority":2,"supported_reasoning_levels":[{"effort":"medium"}]},{"slug":"retired","visibility":"hide","supported_reasoning_levels":[{"effort":"high"}]}]}'
""", encoding="utf-8")
        self.agy.write_text("""#!/bin/sh
printf '%s\\n' 'gemini-4.0-pro-high\tGemini 4.0 Pro (High)' 'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)'
""", encoding="utf-8")
        self.codex.chmod(0o755)
        self.agy.chmod(0o755)
        fde_models._PROCESS_SNAPSHOT = None

    def tearDown(self):
        fde_models._PROCESS_SNAPSHOT = None
        self.tmp.cleanup()

    def environment(self):
        return patch.dict(os.environ, {
            "FDE_CODEX_BIN": str(self.codex),
            "FDE_AGY_BIN": str(self.agy),
            "FDE_MODEL_CATALOG_CACHE": str(self.root / "catalog.json"),
            "FDE_MODEL_DISCOVERY": "live",
        }, clear=False)

    def test_live_catalogue_removes_retired_models_and_adds_new_ones(self):
        with self.environment():
            snapshot = fde_models.refresh(self.root)
            effective = fde_models.apply(self.policy, snapshot)
        codex = {model["id"]: model for model in effective["providers"]["codex"]["models"]}
        gemini = {model["id"]: model for model in effective["providers"]["gemini"]["models"]}
        self.assertNotIn("gpt-5.2", codex)
        self.assertNotIn("gpt-5.5", codex)
        self.assertIn("gpt-6-astra", codex)
        self.assertEqual(codex["gpt-6-astra"]["tier"], "premium")
        self.assertEqual(codex["gpt-5.6-luna"]["efforts"], ["medium"])
        self.assertIn("gemini-4.0-pro-high", gemini)
        self.assertEqual(gemini["gemini-4.0-pro-high"]["tier"], "premium")
        self.assertEqual(effective["_modelDiscovery"]["state"], "live")
        self.assertTrue(effective["_modelDiscovery"]["catalogDigest"].startswith("sha256:"))

    def test_last_known_good_cache_survives_provider_failure(self):
        with self.environment():
            first = fde_models.refresh(self.root)
            self.assertIn("codex", first["providers"])
            fde_models._PROCESS_SNAPSHOT = None
            with patch.dict(os.environ, {"FDE_CODEX_BIN": "missing-codex",
                                         "FDE_AGY_BIN": "missing-agy",
                                         "FDE_MODEL_DISCOVERY": "cache"}, clear=False):
                cached = fde_models.load_snapshot(self.root, live=False)
        self.assertTrue(cached["cacheFallback"])
        self.assertIn("codex", cached["providers"])


if __name__ == "__main__":
    unittest.main()
