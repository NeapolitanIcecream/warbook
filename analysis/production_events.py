"""Task-specific diagnostics from existing journals; use compare_runs.py for scoring.

Fourth-to-fifth tank appearances are cumulative births, not simultaneous army size.
Miner maxima use the existing sparse observations through tick 12000.
Incomplete fifth-tank sequences are reported separately, never given a zero gap.
"""
import json
import statistics
import sys
from pathlib import Path
from experiment_storage import open_text

root = Path(sys.argv[1])
rows = json.loads((root / "summary.json").read_text())["rows"]
plan = json.loads((root / "plan.json").read_text())
expected = len(plan["subjects"]) * len(plan["opponents"]) * len(plan["maps"]) * plan["rounds"]
if len(rows) != expected:
    raise ValueError(f"Incomplete matrix: {len(rows)} of {expected} starts recorded")
output = []
for row in rows:
    directory = Path(row["dir"])
    result = json.loads((directory / "result.json").read_text())
    manifest = json.loads((directory / "manifest.json").read_text())
    actor = next(p["name"] for p in manifest["participants"] if p["role"] == "subject")
    tanks, miners, queues = [], [], []
    max_miners, max_miner_tick = 0, None
    tank_refs = set()
    with open_text(directory / "decisions.ndjson") as journal:
        for line in journal:
            event = json.loads(line)
            if event.get("actor") != actor:
                continue
            tick = event["tick"]
            if event["kind"] == "own_objects_appeared":
                for unit in event["objects"]:
                    if unit["name"] in ("MTNK", "HTNK") and unit["ref"] not in tank_refs:
                        tank_refs.add(unit["ref"])
                        tanks.append(tick)
                    if unit.get("harvester"):
                        miners.append(tick)
            if event["kind"] == "observation" and tick <= 12000:
                count = sum(u["harvester"] for u in event["observation"]["own"])
                if count > max_miners:
                    max_miners, max_miner_tick = count, tick
            if event["kind"] == "submitted" and event["intent"]["kind"] == "queue":
                queues.append({"tick": tick, "product": event["intent"]["product"]["name"]})
    fourth = tanks[3] if len(tanks) > 3 else None
    fifth = tanks[4] if len(tanks) > 4 else None
    out = {k: row[k] for k in ("map", "opponent", "round", "subject", "swapped")}
    out.update(
        dir=str(directory),
        stop=result["stopReason"],
        clean=result.get("cleanCompletionVerified"),
        win=bool(result.get("cleanCompletionVerified") and result.get("outcome", {}).get("survivor") == actor),
        subjectStart=next(p["startLocation"] for p in result["stats"] if p["name"] == actor),
        opponentStart=next(p["startLocation"] for p in result["stats"] if p["name"] != actor),
        fourthTank=fourth,
        fifthTank=fifth,
        gap=fifth - fourth if fifth is not None else None,
        maxObservedMinersBefore12000=max_miners,
        maxMinerTick=max_miner_tick,
        earlyMinerAppearances=miners[:6],
        firstTankAppearances=tanks[:6],
        reinforcementQueues=[q for q in queues if fourth is not None and fourth <= q["tick"] <= (fifth or 12000)],
    )
    output.append(out)
(root / "production-summary.json").write_text(json.dumps(output, indent=2))
for subject in sorted({x["subject"] for x in output}):
    all_rows = [x for x in output if x["subject"] == subject]
    for map_name in ["ALL"] + sorted({x["map"] for x in all_rows}):
        sample = [x for x in all_rows if map_name == "ALL" or x["map"] == map_name]
        gaps = [x["gap"] for x in sample if x["gap"] is not None]
        print(
            subject, map_name, "wins", sum(x["win"] for x in sample), "/", len(sample),
            "gap", statistics.median(gaps) if gaps else None,
            "min/max", (min(gaps), max(gaps)) if gaps else None,
            "missing fifth", len(sample) - len(gaps),
            "over4 observed", sum(x["maxObservedMinersBefore12000"] > 4 for x in sample),
        )
