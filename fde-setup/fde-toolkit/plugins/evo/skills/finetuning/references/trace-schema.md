# Trace schema

evo collects two record types. The glue (producer) and the dashboard/orchestrator
(readers) both conform to these JSON shapes; nothing imports a Python type, so keep
them aligned to this doc.

## Rollout: `TrajectoryRecord` (JSONL, one episode per line)

One scored agent episode. Feeds training (as a dataset) and harness feedback.

| field | type | set by | meaning |
|---|---|---|---|
| `scenario_id` | str | evo | task instance; drives the train/held-out split |
| `policy_id` | str | evo | checkpoint that produced it (base id or a checkpoint id); on-policy filter |
| `harness_hash` | str | evo | scaffold version that produced it; freshness filter |
| `reward` | number | evo (verifier) | per-episode scalar |
| `passed` | bool | evo (gate) | gate outcome |
| `messages` | list | glue | chat incl tool calls; opaque to evo |
| `trainable` | list[bool] \| null | glue | per-message loss mask; length == `messages`; null = trainer decides |
| `group_id` | str \| null | evo/glue | samples that must stay together (DPO pair / GRPO prompt-group) |
| `seed`, `tokens`, `meta` | — | optional | provenance / extras |

evo applies selection (top-N, on-policy, group-preserving) and writes **only
train-split** records to the dataset the glue reads.

## Training run: `TrainingTrace` (one JSON per train activity)

Setup/dynamics fields are written by the glue; outcome/diagnostics by evo. Trust
the evo-computed fields over anything the run self-reports.

**Glue-emitted:** `method`, `base`, `checkpoint`, `hyperparams` ({lora_rank, lr,
epochs, kl_coef, ...}), `framework`, `glue_ref`, `metrics_path`, `steps`,
`tokens`, `wall_time_s`, `early_stop_reason`, `errors[]`.

`metrics_path` → a step-indexed JSONL of `{step, loss, reward, kl, grad_norm, lr}`.

**evo-computed:** `parent_score`, `held_out_score`, `delta`, `per_slice_delta`,
`reward_saturation`, `generalization_gap`. Leakage and held-out-no-regression are
**gates** that pass/fail the node — see `diagnostics.md`.
