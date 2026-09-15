#!/usr/bin/env node
// Parse real replay inputs with the audited published API. Never initializes
// cdapi or simulates a game. Only aggregate, non-chat metadata is retained.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const [packageArg, ...inputs] = process.argv.slice(2);
if (!packageArg || !inputs.length) {
  console.error('Usage: node analysis/probe_replays.cjs <audited-package-directory> <replay.rpl> [...]');
  process.exit(2);
}
const packageDir = path.resolve(packageArg);
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const lockfile = fs.readFileSync(path.join(root, 'analysis/replay-parser/package-lock.json'));
const installedLock = fs.readFileSync(path.resolve(packageDir, '../../..', 'package-lock.json'));
assert.equal(sha256(installedLock), sha256(lockfile), 'Parser installation lock differs from recorded lock');
const publicFixtures = {
  '0c82f0d5-cd5b-4f90-b3db-3d2c4aa93aa0': 'c2a8372abbc5a6a740ddbbe83a4c668565dade0c620049d871675f67114d7ac9',
  '639963f0-7654-4a85-a02d-b5f8d6aa20d3': 'b46e02331d5e2e1bf88ad95774296d78c39c2d8ea13559e8bf749b67aace892d',
};
const provenance = JSON.parse(fs.readFileSync(path.join(root, 'docs/references/api-provenance.json'), 'utf8'));
for (const artifact of provenance.artifacts) {
  const bytes = fs.readFileSync(path.join(packageDir, artifact.package_path));
  assert.equal(bytes.length, artifact.size_bytes, `Size mismatch: ${artifact.package_path}`);
  assert.equal(sha256(bytes), artifact.sha256, `Hash mismatch: ${artifact.package_path}`);
}
const { Replay, ReplayEventType, ActionType } = require(packageDir);
const add = (object, key) => { object[key] = (object[key] || 0) + 1; };

const observations = inputs.map(input => {
  const bytes = fs.readFileSync(path.resolve(input));
  const replay = Replay.parse(bytes.toString('utf8'));
  const expectedHash = publicFixtures[replay.gameId];
  if (expectedHash) assert.equal(sha256(bytes), expectedHash, 'Known public fixture content changed');
  const eventTypes = {};
  const actionTypes = {};
  let totalActions = 0;
  let turnEvents = 0;
  let minimumTick = Infinity;
  let maximumTick = -Infinity;
  let eventsNondecreasing = true;
  let lastTick = -Infinity;
  const playerIds = new Set();
  for (const event of replay.events) {
    assert.ok(Number.isInteger(event.tick) && event.tick >= 0, 'Unexpected event tick');
    eventsNondecreasing &&= event.tick >= lastTick;
    lastTick = event.tick;
    minimumTick = Math.min(minimumTick, event.tick);
    maximumTick = Math.max(maximumTick, event.tick);
    add(eventTypes, ReplayEventType[event.type] ?? `unknown_${event.type}`);
    if (event.type !== ReplayEventType.TurnActions) continue;
    turnEvents += 1;
    assert.ok(Array.isArray(event.payload.playerActions));
    for (const player of event.payload.playerActions) {
      playerIds.add(player.playerId);
      for (const action of player.actions) {
        add(actionTypes, ActionType[action.type] ?? `unknown_${action.type}`);
        totalActions += 1;
      }
    }
  }
  assert.equal(Object.values(actionTypes).reduce((a, b) => a + b, 0), totalActions);
  assert.equal(Object.values(eventTypes).reduce((a, b) => a + b, 0), replay.events.length);
  const game = replay.gameOpts;
  return {
    game_id: replay.gameId,
    source_url: expectedHash ? `https://replays-eu.chronodivide.com/${encodeURIComponent(replay.gameId)}.rpl` : null,
    origin_status: expectedHash ? 'hash_verified_public_fixture' : 'caller_supplied_local_input',
    bytes: bytes.length,
    sha256: sha256(bytes),
    api_parse_succeeded: true,
    engine_version_marker: replay.engineVersion,
    mod_hash_marker: replay.modHash,
    map_name: game.mapName,
    map_digest: game.mapDigest,
    map_official_marker: game.mapOfficial,
    human_player_entries: game.humanPlayers.length,
    internal_ai_slot_records: game.aiPlayers.length,
    nonempty_internal_ai_entries: game.aiPlayers.filter(value => value !== null && value !== undefined).length,
    unique_action_player_ids: playerIds.size,
    setup: {
      game_speed: game.gameSpeed,
      credits: game.credits,
      unit_count: game.unitCount,
      short_game: game.shortGame,
      super_weapons: game.superWeapons,
      crates: game.cratesAppear,
    },
    recorded_end_tick: replay.endTick,
    minimum_event_tick: Number.isFinite(minimumTick) ? minimumTick : null,
    maximum_event_tick: Number.isFinite(maximumTick) ? maximumTick : null,
    events_nondecreasing: eventsNondecreasing,
    event_count: replay.events.length,
    event_types: eventTypes,
    turn_action_event_count: turnEvents,
    attempted_action_count: totalActions,
    attempted_action_types: actionTypes,
    simulation_executed: false,
    playback_compatibility_verified: false,
    action_effects_verified: false,
    legal_observations_reconstructed: false,
  };
});

const report = {
  evidence_kind: 'real_public_replay_parse_only',
  api_version: provenance.package.version,
  node_version: process.version,
  parser_dependency_lock_sha256: sha256(lockfile),
  resources_initialized: false,
  engine_simulated: false,
  raw_chat_and_player_names_retained_in_report: false,
  selection_note: 'Caller-selected availability inputs. The initial published run uses two public fixtures from one ladder history; not a representative dataset or held-out benchmark.',
  scope: 'Verifies only audited parser acceptance and structural metadata. Version markers do not prove map/mod availability, playback, command success, observations, or causal labels.',
  observations,
};
const output = path.join(root, 'docs/references/replay-parse-probe.json');
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
