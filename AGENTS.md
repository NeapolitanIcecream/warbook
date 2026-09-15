# Working agreement

Build a Chrono Divide AI whose progress is supported by complete-game evidence. Read `README.md` and the relevant design document before working; keep records proportional to the task.

- Distinguish source-verified API facts, runtime measurements, hypotheses, and proposed defaults. Never report an unrun experiment as passing.
- Use the pinned Chrono Divide engine as the behavioral reference. Player observations, action semantics, replay compatibility, initialization, and timing need explicit validation.
- Keep engine truth separate from legal actor observations and inferred beliefs. Audit indirect leaks through events, masks, IDs, and runtime planning.
- Mechanism tests, local decision experiments, and full-game evaluation support different claims. Preserve that distinction in reports.
- Start from a concrete observed failure, compare plausible causes, and make the smallest informative intervention. Negative findings count when they change the next decision.
- Keep candidate policy changes separate from changes to evaluation rules. If a scoring rule changes, rerun the baseline under the new rule.
- Do not assume seeded reset, fixed starting positions, replay takeover, or snapshot restore exist. Follow `docs/environment-audit.md` and verify any added adapter.
- Keep a runnable baseline and compare meaningful alternatives. Use rules, search, supervised learning, or RL according to evidence; no algorithm is a required milestone.
- Use complete-game/source groups for data splits. Do not tune on held-out results and continue calling them unseen.
- Add infrastructure only when it enables a named near-term experiment. Avoid process work that delays the next useful complete-game run.
- Do not commit game assets, credentials, large replays, datasets, checkpoints, or generated run artifacts. Store paths and reproducibility metadata instead.
- Current repository status is design plus resource-free analysis probes. Replay parsing and extracted-method mocks are not engine simulation, gameplay, or training. Future implementation work should update status with evidence at the correct level.
