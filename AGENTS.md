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
- Optimize for delivering a capable RA2 AI quickly and well. Apply this to design, code, experiments, and reviews: prefer direct solutions, reuse, and the smallest checks that can change the current decision. Do not add speculative infrastructure, fallback layers, exhaustive gates, or documentation rituals merely to defend against hypothetical future cases. Explicit uncertainty should lead to a small useful experiment, not indefinite preparation.
- Inspect structure and performance periodically: by default after three substantive development/experiment iterations or at a milestone, and sooner when recurring fixes, coupled changes, unclear control ownership, or slow execution impede progress. This is a brief review within the current task, not a scheduled automation or a mandatory refactoring quota; if no concrete need exists, continue.
- When that review finds a worthwhile refactor or optimization needed for reliable behavior, maintainability, development speed, or useful sampling throughput, pause the affected feature/experiment work and carry out the improvement autonomously. Structural evidence can justify refactoring without a performance benchmark; performance claims need a comparable measured workload. Keep the change scoped, validate relevant behavior, and resume the goal-facing work once the concrete problem is resolved. Do not wait for another user confirmation or expand the pause into a general rewrite.
- Do not commit game assets, credentials, large replays, datasets, checkpoints, or generated run artifacts. Store paths and reproducibility metadata instead.
- Current repository status is design plus resource-free analysis probes. Replay parsing and extracted-method mocks are not engine simulation, gameplay, or training. Future implementation work should update status with evidence at the correct level.
