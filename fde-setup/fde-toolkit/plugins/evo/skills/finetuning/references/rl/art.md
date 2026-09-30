# Recipe: RL (GRPO) via OpenPipe ART

ART trains GRPO on scored trajectory groups and self-serves the LoRA in vLLM
(OpenAI-compatible). Best fit for evo's pre-scored trajectories. Judgment is in `SKILL.md`.

## Train

- `art.TrainableModel(base_model=EVO_PARENT_POLICY)`; register a backend
  (`LocalBackend` on a rented GPU, or SkyPilot/serverless).
- Build `art.Trajectory(messages_and_choices=..., reward=<scalar from EVO_DATASET>)`,
  grouped by `group_id` (one prompt-group per ART group). Keep groups intact.
- `await model.train(groups, art.TrainConfig(...))` — one GRPO iteration (train + reload).

## Serve

- `model.openai_client()` / its inference base_url already serves the latest LoRA.
  Point the benchmark's model there.

## Notes

- In pure-RL usage ART owns the rollout loop; in evo's pre-scored mode you assign
  `reward` yourself from `EVO_DATASET` (evo collected and scored it).
- Auto-resumes from the latest checkpoint by step; record the checkpoint dir as the artifact.
