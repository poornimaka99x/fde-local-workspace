# Recipe: serving a LoRA checkpoint via vLLM

For **train-only** backends (TRL, Unsloth, verl, Axolotl) whose output is a PEFT
adapter, serve it yourself. Default design: one shared base-model server hosting many
LoRA adapters, hot-swapped and selected per request by model name (= tree-node id),
so node evaluation is a sub-second adapter swap. (Tinker and ART self-serve — you do
not need this for them.)

## Launch

- `vllm serve <base_model> --enable-lora --max-lora-rank <>= adapter rank> --max-loras <N>`
  (optionally `--api-key ...`). OpenAI routes at `/v1/chat/completions`.

## Hot-swap (no restart)

- Set `VLLM_ALLOW_RUNTIME_LORA_UPDATING=1`.
- `POST /v1/load_lora_adapter {lora_name, lora_path}` / `POST /v1/unload_lora_adapter {lora_name}`.
- Select per request via the `model` field (the adapter name). `--max-cpu-loras` is the LRU pool.

## Notes

- The chat template must match training (serving drift). Record the base model on the
  `CheckpointRef` so the right server hosts it.
- Scale-to-zero is not native — wrap the server in Modal/RunPod if idle cost matters.
