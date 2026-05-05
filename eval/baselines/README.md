# Eval baselines

These numbers measure loop + executor correctness against scripted tool sequences, not live agent behavior. Live numbers will land when the BullMQ→Anthropic→Playwright dispatcher ships — see [`../../ROADMAP.md`](../../ROADMAP.md).

## Files

- `golden_v1_fake.json` — committed baseline for `--suite golden_v1 --provider fake`. Each flow is run twice; `replay_determinism_score` is the share of step indices where the tool name matched between the two runs.

## Regenerate

```sh
pnpm bench-eval
```

The bench script writes a timestamped artifact under `eval/runs/` so the committed baseline is never overwritten by accident.

## Field reference

Per-flow:

| Field                      | Meaning                                                                        |
| -------------------------- | ------------------------------------------------------------------------------ |
| `success`                  | The agent loop reached `finish` with the scripted tool sequence.               |
| `step_count`               | Number of executed tool calls, including the terminal `finish`.                |
| `replay_determinism_score` | 1 − (positions where two consecutive runs disagreed on the tool name) / steps. |
| `simulated_cost_usd`       | Sum of `FakeLLMProvider` step costs; not a real-model price.                   |

There is no latency column. The provider is a synchronous fake; reporting wall-clock here would be a number about Node.js, not about the agent.
