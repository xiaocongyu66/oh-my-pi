# skill-evolution: promotion + concept map

This directory ports Microsoft **SkillOpt / ReflACT** (arXiv 2605.23904) to omp's
nightly skill-evolution loop. Every ported concept carries an **original anchor**
(`file:line` into the SkillOpt source) so a reader can verify each mapping against
the real code instead of trusting the summary. The promotion module
(`promotion.ts`) is the final stage: it turns a converged training run into a
deployable `SKILL.md`.

## Module architecture

Two layers, enforced by convention:

- **Pure core** — `gate.ts`, `scoring.ts`, `optimizer.ts` (edit types + apply),
  `promotion.ts` (`serializeProvenance` / `readProvenance` / `isProvenance`).
  No IO, fully unit-testable, mirroring the original's split of pure decision
  functions from side effects (gate.py:5-8: "The trainer owns side-effects …
  This module is the pure decision function").
- **IO convergence** — every disk mutation funnels through ONE guarded writer:
  training state through `EvolutionStorage` (`storage.ts`, tmp-file + rename,
  confined to `~/.omp/agent/evolution/<slug>/`), and the deployed artifact
  through `writeManagedSkill` (`../autolearn/managed-skills.ts`, confined to
  `~/.omp/agent/managed-skills/` with symlink/hardlink/64KB guards).
  `promoteSkill` adds no second write path — it composes a body and delegates.

Invariants:

1. The selection (held-out) split is only ever scored by the gate — its prompts
   never enter the optimizer (trainer.ts header; original trainer.py:1084-1087).
2. Promotion only ships gate-accepted (`accept` / `accept_new_best`) and
   L2-verified skills; `reject` is not a representable provenance action.
3. The red line: promotion writes ONLY into the managed-skills directory —
   never project `.omp`/`.claude`, never user-authored skills.

## Provenance field semantics

`promotion.ts → Provenance`, written as `<!-- omp-provenance {json} -->` at the
head of the skill body (see "Metadata representation" below):

| Field                   | Semantics                                                                                                     | Original anchor                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `skill`                 | Slug of the evolved skill (omp needs a name; the original trains one skill per `out_root`).                   | — (runtime_state has no name key, trainer.py:1060-1075)                                 |
| `epochs`                | Completed training steps of the promoting run.                                                                | runtime_state `last_completed_step`, trainer.py:1064                                    |
| `validationScoreBefore` | Gate-metric-space selection score of the incumbent before the promoting step.                                 | runtime_state `current_score`, trainer.py:1068 (set at baseline trainer.py:1142-1149)   |
| `validationScoreAfter`  | Score of the accepted candidate after the gate.                                                               | `GateResult.current_score` (candidate score), gate.py:39, 204-216                       |
| `gateAction`            | `"accept_new_best" \| "accept"` — the action that produced the deployed best skill.                           | `GateAction`, gate.py:30; best_skill only changes on `accept_new_best`, gate.py:200-217 |
| `bestScore`             | Best-so-far metric-space score at promotion time.                                                             | `GateResult.best_score` gate.py:42; runtime_state `best_score` trainer.py:1071          |
| `bestStep`              | Step at which the best skill was accepted.                                                                    | `GateResult.best_step` gate.py:43; runtime_state `best_step` trainer.py:1072            |
| `l2AvgQuality`          | Mean `L2SampleResult.quality` over the real-execution verification sample; `undefined` when no sample scored. | omp-specific; closest original analog: best-skill test soft score, trainer.py:2319-2333 |
| `promotedAt`            | ISO stamp of the adoption.                                                                                    | — (original `best_skill.md` is untimestamped, trainer.py:2199-2201)                     |

## Concept map

| SkillOpt concept                                                                                     | Original anchor                                                                                                                                          | This port (file → export)                                                                                                              | CC Skill Creator counterpart                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Validation gate, three-state `accept_new_best` / `accept` / `reject`, strict `>` vs current AND best | `skillopt/evaluation/gate.py:30` (type), `:200-225` (decision)                                                                                           | `evolution/gate.ts → evaluateGate`                                                                                                     | none — skill-creator relies on human review, no held-out gate                                                                                                  |
| `GateResult` score/step bookkeeping                                                                  | `skillopt/evaluation/gate.py:34-43`                                                                                                                      | `Provenance.bestScore/bestStep`; `evolution/types.ts → EvolutionState`                                                                 | none                                                                                                                                                           |
| Deployable artifact `best_skill.md` (per-step + final persist)                                       | `skillopt/engine/trainer.py:1739-1743` (per step), `:2199-2201` (end of run)                                                                             | `promoteSkill` → `<agentDir>/managed-skills/<slug>/SKILL.md`; training-side twin `evolution/storage.ts → writeBestSkill`               | the skill-creator's finished `SKILL.md` deliverable                                                                                                            |
| Runtime state (current/best double track, paths, origins)                                            | `skillopt/engine/trainer.py:1060-1075` (`_persist_runtime_state`)                                                                                        | `evolution/types.ts → EvolutionState` + `evolution/storage.ts → writeState/readState` (`state.json`)                                   | none — skill-creator keeps no cross-run state                                                                                                                  |
| Final-skill val + "promote final → best"                                                             | `skillopt/engine/trainer.py:2221-2274`                                                                                                                   | `evolution/trainer.ts → onPromoted` handoff → `promoteSkill`                                                                           | none                                                                                                                                                           |
| Versioned snapshots `skills/skill_vNNNN.md`                                                          | `skillopt/engine/trainer.py:371-375` (`_save_skill`)                                                                                                     | `evolution/storage.ts → snapshotCandidate` (`candidates/skill-<hash>.md`)                                                              | skill-creator keeps a single working copy per skill                                                                                                            |
| Gate metric projection (hard / soft / mixed)                                                         | `skillopt/evaluation/gate.py:85-132`                                                                                                                     | `evolution/gate.ts → selectGateScore` (`TrainConfig.gateMetric`)                                                                       | none                                                                                                                                                           |
| Semantic density of leading words                                                                    | `skillopt/evaluation/gate.py:46-82`                                                                                                                      | `evolution/gate.ts → computeSemanticDensity`                                                                                           | none                                                                                                                                                           |
| Edit representation: `Edit{op, content, target}` / `Patch`                                           | `skillopt/types.py:23-99`                                                                                                                                | `evolution/optimizer.ts → EditOp/EditReport`, `applyPatchWithReport`                                                                   | skill-creator rewrites whole sections; no typed edit ops                                                                                                       |
| Reflect stage: failure/success analysts over minibatches                                             | `skillopt/gradient/reflect.py:485-505` (`run_minibatch_reflect`), `:549-558` (split), analysts `:269` / `:379`                                           | `evolution/optimizer.ts → proposeEdits`, `selectLowRollouts`; judge in `evolution/judge.ts`                                            | skill-creator's brainstorm/interview → draft phase                                                                                                             |
| (hard, soft) rollout scoring                                                                         | `skillopt/types.py:104-113` (`RolloutResult.hard/soft`); batch aggregate `trainer.py:1314-1317`                                                          | `evolution/scoring.ts → computeScore`; `evolution/rollout.ts → conditionScore`                                                         | none                                                                                                                                                           |
| Metadata embedded in skill content as HTML comment blocks                                            | `skillopt/evaluation/gate.py:59-73` (strips `<!-- SLOW_UPDATE_START -->` etc. before scoring)                                                            | `promotion.ts → serializeProvenance/readProvenance` (`<!-- omp-provenance {json} -->`); same markers in `evolution/optimizer.ts:46-49` | skill-creator puts metadata in YAML frontmatter (`name`, `description`) — which is exactly what promotion preserves verbatim and keeps machine metadata OUT of |
| Sleep: consolidate → **stage** → review → **adopt** (human-gated deployable artifact)                | `docs/sleep/README.md:19-23` (night pipeline), `skillopt_sleep/staging.py:1-5` (stage then explicit adopt), `docs/sleep/README.md:150-155` (`adopt` CLI) | `promotion.ts → promoteSkill` = the adopt step (runs only after gate + L2 pass)                                                        | skill-creator: human authors/installs the skill, Claude Code discovers it                                                                                      |

### Metadata representation (why a body comment, not frontmatter)

`writeManagedSkill` builds the frontmatter itself via `toSkillFrontmatter`
(managed-skills.ts:75-82) — only `name` + `description`, and the description is
force-sanitized to a single line (`sanitizeManagedDescription`,
managed-skills.ts:62-69), so it cannot carry JSON. Rather than fork that writer,
provenance rides at the head of the body as an HTML comment — the same
machine-metadata convention the original uses for `<!-- SLOW_UPDATE_START -->`
blocks (gate.py:59-73). Consequences, all verified in `promotion.test.ts`:

- The comment sits after the frontmatter close delimiter: `parseFrontmatter`
  still yields clean `{name, description}`.
- Repo `parseFrontmatter` in default repair mode strips HTML comments from the
  body it returns (packages/utils/src/frontmatter.ts:5-7, 145), so
  frontmatter-first consumers never see machine metadata; the bytes on disk
  keep it, and `readProvenance` reads from raw file content.
- Trade-off: `computeSemanticDensity` (gate.ts) only strips the four original
  markers, not this one. Provenance JSON keys/values never intersect the
  leading-word list, so the effect is limited to slight dilution when
  `useSemanticDensity` is enabled.

## When upstream (SkillOpt) changes, patch here

| Upstream change                                               | Where to port it                                                                                                                     |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `evaluation/gate.py` decision/metrics                         | `evolution/gate.ts`; if a new gate action becomes promotable, widen `Provenance.gateAction` + `GATE_ACTION_VALUES` in `promotion.ts` |
| runtime-state keys (`trainer.py:1060-1075`)                   | `evolution/types.ts → EvolutionState`, persist calls in `trainer.ts`, and the matching `Provenance` fields                           |
| `best_skill.md` write policy (e.g. persist on `force_accept`) | `trainer.ts` accept branch (`writeBestSkill`) + `Provenance.gateAction` union                                                        |
| `gradient/reflect.py` / `types.py` edit shapes                | `evolution/optimizer.ts` (`EditOp`, apply) — `promotion.ts` is unaffected                                                            |
| Sleep staging/adopt semantics (`skillopt_sleep/staging.py`)   | `promotion.ts` (adopt-step composition); the write path stays `writeManagedSkill`                                                    |
| Managed-skill format (frontmatter shape, size cap) in omp     | adapt `promoteSkill` body composition + `promotion.test.ts` only — promotion must keep using the public `writeManagedSkill` API      |
