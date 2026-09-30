# Recipe: SFT via Tinker (managed LoRA)

Tinker (Thinking Machines) is a managed LoRA train + sample API. It self-serves an
OpenAI-compatible endpoint, so train and serve both live here. Key: `TINKER_API_KEY`.
This file is "how to call Tinker"; the judgment (method, hyperparameters) is in `SKILL.md`.

## Train

- Create a LoRA training client for `EVO_PARENT_POLICY` (`base_model=`), rank ~32.
- Render each `EVO_DATASET` record with the harness's chat template; mask loss to
  assistant tokens (honor `trainable`).
- Loop: `forward_backward(batch, loss="cross_entropy")` then `optim_step(AdamParams(lr=~1e-4))`.
- Evaluate on a cadence; stop on held-out plateau (evo runs the held-out gate, not you).
- `save_weights_for_sampler(name=...)` → a `tinker://...` checkpoint ref.

## Serve

- The `tinker://` ref serves via Tinker's OpenAI-compatible endpoint. Point the
  benchmark's model at it: `base_url` + the ref as the model name, key from `TINKER_API_KEY`.

## Emit

- Checkpoint artifact `uri` = the `tinker://` ref. Write `train_summary.json` + `metrics.jsonl`
  per `trace-schema.md`.

Warm-start a child from a parent checkpoint via `load_state`. Tinker exports merged
HF weights if you ever need to serve elsewhere.
