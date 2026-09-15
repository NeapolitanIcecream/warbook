#!/usr/bin/env node
'use strict';

// Mock-only probe of one method extracted at runtime from the pinned npm bundle.
// Usage: node analysis/probe_order_units.cjs /absolute/path/to/dist/index.js
// Optional capture: redirect stdout to docs/references/order-units-probe.json.
// This does not import the game package, load MIX files, or initialize the engine.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');

if (process.argv.length !== 3) {
  console.error('Usage: node analysis/probe_order_units.cjs /path/to/game-api/dist/index.js');
  process.exit(2);
}
const provenancePath = path.resolve(__dirname, '../docs/references/api-provenance.json');
const provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8'));
const artifact = provenance.artifacts.find((entry) => entry.id === 'bundle');
if (!artifact) throw new Error('Pinned bundle provenance is missing');
const bytes = fs.readFileSync(path.resolve(process.argv[2]));
const digest = crypto.createHash('sha256').update(bytes).digest('hex');
if (digest !== artifact.sha256 || bytes.length !== artifact.size_bytes) {
  throw new Error('Bundle bytes do not match the existing pinned SHA-256 and size; probe not run');
}
const source = bytes.toString('utf8');
const startMarker = 'orderUnits(t,i,r,s,a){';
const endMarker = 'sayAll(e){';
const offset = source.indexOf(startMarker);
const end = source.indexOf(endMarker, offset);
if (offset < 0 || end < 0 || source.indexOf(startMarker, offset + 1) >= 0) {
  throw new Error('Expected unique method boundary was not found; probe not run');
}
const method = source.slice(offset, end);
const cases = [
  {
    name: 'ordinary_tile', args: [[1], 0, 3, 4],
    expected: {queuedActionTypes: [8, 9], target: {tile: {rx: 3, ry: 4}}, error: null}
  },
  {
    name: 'zero_rx_truthiness_branch', args: [[1], 0, 0, 4],
    expected: {queuedActionTypes: [8, 9], target: null, error: null}
  },
  {
    name: 'zero_ry_truthiness_branch', args: [[1], 0, 3, 0],
    expected: {queuedActionTypes: [8, 9], target: {objectId: 3, tile: {rx: 8, ry: 9}}, error: null}
  },
  {
    name: 'missing_object_leaves_selection', args: [[1], 2, 999],
    expected: {queuedActionTypes: [8], target: null, error: null}
  },
  {
    name: 'invalid_tile_throws_after_selection', args: [[1], 0, 3, 999],
    expected: {queuedActionTypes: [8], target: null, error: 'No tile found at rx,ry=3,999'}
  }
];

// Only source text and JSON literals enter the context; no host objects/functions
// are exposed. The fake game/queue and API helper names are created inside the VM.
const probeSource = `(() => {
  'use strict';
  const cases = ${JSON.stringify(cases)};
  return JSON.stringify(cases.map((test) => {
    const queue = [];
    const game = {
      map: {
        tiles: { getByMapCoords: (rx, ry) => ry === 999 ? undefined : {rx, ry} },
        tileOccupation: { getBridgeOnTile: () => undefined }
      },
      getWorld: () => ({ hasObjectId: (id) => id === 3 }),
      getObjectById: (id) => ({id, tile: {rx: 8, ry: 9}}),
      createTarget: (object, tile) => ({objectId: object?.id, tile})
    };
    const _ActionsApi_instances = {};
    const _ActionsApi_game = {};
    const ActionType = { SelectUnits: 8, OrderUnits: 9 };
    function _ActionsApi_pushAction(type, initialize) {
      const action = {type};
      initialize?.(action);
      queue.push(action);
    }
    function ActionsApi_classPrivateFieldGet(instance, slot, kind, method) {
      if (kind === 'm' && slot === _ActionsApi_instances && method === _ActionsApi_pushAction) return method;
      if (kind === 'f' && slot === _ActionsApi_game) return game;
      throw new Error('Unexpected helper access in extracted method');
    }
    const api = {${method}};
    let error = null;
    try { api.orderUnits(...test.args); } catch (failure) { error = failure.message; }
    const actual = JSON.parse(JSON.stringify({
      queuedActionTypes: queue.map((action) => action.type),
      target: queue.find((action) => action.type === 9)?.target ?? null,
      error
    }));
    return {name: test.name, args: test.args, expected: test.expected, actual,
      matched: JSON.stringify(actual) === JSON.stringify(test.expected)};
  }));
})()`;
const context = vm.createContext(Object.create(null), {
  name: 'order-units-mock-only',
  codeGeneration: {strings: false, wasm: false}
});
const timeoutMs = 1000;
const serialized = new vm.Script(probeSource, {filename: 'pinned-order-units-mock.js'})
  .runInContext(context, {timeout: timeoutMs});
const results = JSON.parse(serialized);
const report = {
  schema_version: 1,
  probe: 'pinned-order-units-parameter-branches',
  executed_at_utc: new Date().toISOString(),
  node_version: process.version,
  evidence_level: 'source-method-tested',
  scope: 'mock-only',
  real_engine_initialized: false,
  game_resources_loaded: false,
  source: {
    provenance: 'docs/references/api-provenance.json#bundle',
    package: `${provenance.package.name}@${provenance.package.version}`,
    public_url: artifact.public_url,
    sha256: digest,
    size_bytes: bytes.length,
    search_marker: startMarker,
    character_offset_zero_based: offset,
    extracted_method_characters: method.length
  },
  isolation: {host_capabilities_exposed: [], dynamic_string_codegen: false, wasm_codegen: false, timeout_ms: timeoutMs},
  mock_assumptions: ['Only object ID 3 exists, at tile (8,9).', 'Tile lookup returns no tile when ry=999; other coordinates are accepted by the mock.', 'Action submission only stores in a fake queue; no action is executed.'],
  result_summary: {cases: results.length, matched_expected: results.filter((result) => result.matched).length},
  results,
  limitations: [
    'Matching confirms these branches of the extracted method under the declared mocks, not game-engine behavior.',
    'This does not prove any real map has a valid tile whose rx or ry is zero.',
    'This does not test order validation, fallback orders, pathfinding, combat, replay compatibility, or match outcomes.',
    'VM isolation and the pinned hash bound this trusted-source probe; the script is not a sandbox for arbitrary untrusted bundles.'
  ]
};
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
if (results.some((result) => !result.matched)) process.exitCode = 1;
