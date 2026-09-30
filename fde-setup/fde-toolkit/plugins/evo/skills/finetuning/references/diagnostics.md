# Diagnostics: what evo computes vs how to read it

The numbers come from evo (not the run's self-report); the interpretation is yours.

## Gates (pass/fail — abort or keep the node)

- **no eval-data leakage** — the training set's scenarios are disjoint from the
  held-out slice. This is the structural anti-self-deception guarantee; a skill
  cannot enforce it, a gate can.
- **held-out no-regression** — the checkpoint's held-out score is at least the
  parent's (or above a configured floor).
- **adapter loads** — the produced checkpoint loads and serves.
- **reward version recorded**, **cost cap not exceeded**.

## Recorded numbers (on `TrainingTrace`)

- `held_out_score` / `parent_score` / `delta` — did this move help? `delta <= 0` means it didn't.
- `reward_saturation` — fraction of the **selected training set** that passed. Near
  0 or near 1 is a degenerate signal: RFT has nothing to select, RL groups have zero advantage.
- `generalization_gap` — train mean reward minus `held_out_score`. Large means overfit or leakage.
- `per_slice_delta` — where the checkpoint gained or regressed (e.g. by difficulty tier).

## Reading the numbers → likely fix

- low `held_out_score` but high train reward (large `generalization_gap`) → overfit/leak: fewer epochs, lower rank, more/diverse data.
- `reward_saturation` near 0 or 1 → degenerate signal: widen difficulty or change selection.
- flat loss → LR too low or data too homogeneous.
- reward up but `held_out_score` down → reward hacking: raise the KL penalty.
- `delta <= 0` across several train moves → method exhausted: try a different method, or improve the harness instead of the weights.
