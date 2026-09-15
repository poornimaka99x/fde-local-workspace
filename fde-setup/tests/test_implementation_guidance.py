from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class ImplementationCommentGuidance(unittest.TestCase):
    def test_shared_standard_defaults_to_no_code_comments(self):
        standards = (ROOT / "claude-shared/shared/engineering-standards.md").read_text()

        self.assertIn("Do not add code comments by default", standards)
        self.assertIn("Comments **MUST NOT** narrate the implementation", standards)
        self.assertIn("Do not generate boilerplate doc comments", standards)

    def test_implementation_prompts_apply_the_comment_standard(self):
        prompt_paths = (
            ROOT / "fde-toolkit/plugins/fde-core/skills/implementation/SKILL.md",
            ROOT / "fde-toolkit/plugins/fde-core/agents/implementation-engineer.md",
        )

        for prompt_path in prompt_paths:
            with self.subTest(prompt=prompt_path.name):
                prompt = " ".join(prompt_path.read_text().split())
                self.assertIn("Do not add code comments by default", prompt)


if __name__ == "__main__":
    unittest.main()
