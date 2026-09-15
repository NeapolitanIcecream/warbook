#!/usr/bin/env node
// Pure import and constructor probe. Never creates a game, initializes MIX
// resources, installs a context, or calls a bot lifecycle method.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const installDir = path.resolve(process.argv[2] || path.join(root, 'work/opponent-loader'));
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const relative = file => path.relative(installDir, file).split(path.sep).join('/');
const sanitize = value => String(value).split(installDir).join('<installation>');
const expectedBotVersion = '0.6.8-beta.3-165b77a';

for (const file of ['package.json', 'package-lock.json']) {
  assert.equal(
    sha256(fs.readFileSync(path.join(installDir, file))),
    sha256(fs.readFileSync(path.join(root, 'analysis/opponent-loader', file))),
    `Installation differs from recorded ${file}`,
  );
}
const lockBytes = fs.readFileSync(path.join(installDir, 'package-lock.json'));
const lock = JSON.parse(lockBytes);
const apiDir = path.join(installDir, 'node_modules/@chronodivide/game-api');
const botDir = path.join(installDir, 'node_modules/@supalosa/chronodivide-bot');
const apiPackage = readJson(path.join(apiDir, 'package.json'));
const botPackage = readJson(path.join(botDir, 'package.json'));
assert.equal(apiPackage.version, '0.79.0');
assert.equal(botPackage.version, expectedBotVersion);

// Verify the audited API bytes before import, not only its version string.
const apiProvenance = readJson(path.join(root, 'docs/references/api-provenance.json'));
for (const artifact of apiProvenance.artifacts) {
  assert.equal(sha256(fs.readFileSync(path.join(apiDir, artifact.package_path))), artifact.sha256);
}
const ecosystem = readJson(path.join(root, 'docs/references/ecosystem-sources.json'));
const botProvenance = ecosystem.supalosa_packages.find(item => item.version === expectedBotVersion);
assert.ok(botProvenance);
assert.equal(lock.packages['node_modules/@supalosa/chronodivide-bot'].integrity, botProvenance.integrity);

// Traverse installed package directories (including nested node_modules), rather
// than treating a top-level lock entry as proof that only one API exists.
const apiInstallations = [];
const visited = new Set();
function visitNodeModules(directory) {
  if (!fs.existsSync(directory)) return;
  const real = fs.realpathSync(directory);
  if (visited.has(real)) return;
  visited.add(real);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const entryPath = path.join(directory, entry.name);
    if (!fs.statSync(entryPath).isDirectory()) continue;
    const candidates = entry.name.startsWith('@')
      ? fs.readdirSync(entryPath).map(name => path.join(entryPath, name))
      : [entryPath];
    for (const candidate of candidates) {
      const manifest = path.join(candidate, 'package.json');
      if (fs.existsSync(manifest)) {
        const pkg = readJson(manifest);
        if (pkg.name === '@chronodivide/game-api') {
          apiInstallations.push({ path: relative(candidate), version: pkg.version });
        }
      }
      visitNodeModules(path.join(candidate, 'node_modules'));
    }
  }
}
visitNodeModules(path.join(installDir, 'node_modules'));

// ESM evaluation runs from the installation directory, so native bare imports
// resolve exactly as a driver in that directory would. Each check is isolated.
function runChild(code) {
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', code], {
    cwd: installDir, encoding: 'utf8', timeout: 10000,
  });
  const observation = {
    process_exit_code: result.status,
    signal: result.signal,
    timed_out: result.error?.code === 'ETIMEDOUT',
  };
  if (result.error) observation.process_error = sanitize(result.error.message);
  if (result.stderr.trim()) observation.stderr = sanitize(result.stderr.trim());
  try { observation.result = JSON.parse(result.stdout.trim()); }
  catch { observation.unparsed_stdout = sanitize(result.stdout.trim()); }
  return observation;
}

const bare = runChild(`
  try {
    const namespace = await import('@supalosa/chronodivide-bot');
    console.log(JSON.stringify({ imported: true, exports: Object.keys(namespace).sort() }));
  } catch (error) {
    console.log(JSON.stringify({ imported: false, error_name: error.name, error_code: error.code,
      error_message: String(error.message).split(process.cwd()).join('<installation>') }));
  }
`);

const deep = runChild(`
  import fs from 'node:fs';
  import path from 'node:path';
  import { createRequire } from 'node:module';
  const requireHere = createRequire(path.join(process.cwd(), 'package.json'));
  const relative = file => path.relative(process.cwd(), file).split(path.sep).join('/');
  const forbiddenCalls = [];
  try {
    const api = await import('@chronodivide/game-api');
    for (const name of ['init', 'createGame', 'loadReplay']) {
      Object.defineProperty(api.cdapi, name, { configurable: true, value() {
        forbiddenCalls.push('cdapi.' + name); throw new Error('Forbidden in load-only probe: ' + name);
      } });
    }
    const specifier = '@supalosa/chronodivide-bot/dist/bot/bot.js';
    const botEntry = requireHere.resolve(specifier);
    const apiFromRoot = requireHere.resolve('@chronodivide/game-api');
    const apiFromBot = createRequire(botEntry).resolve('@chronodivide/game-api');
    const namespace = await import(specifier);
    const { SupalosaBot } = namespace;
    const hooks = ['onGameInit', 'onGameStart', 'onGameTick', 'onGameEvent', 'setContext'];
    const lifecycleTypes = Object.fromEntries(hooks.map(name => [name, typeof SupalosaBot.prototype[name]]));
    // Guard, rather than invoke, each lifecycle entry during construction.
    for (const name of hooks) {
      Object.defineProperty(SupalosaBot.prototype, name, { configurable: true, value() {
        forbiddenCalls.push('bot.' + name); throw new Error('Forbidden in load-only probe: ' + name);
      } });
    }
    const country = 'Americans';
    const instance = new SupalosaBot('load-probe-only', country, [], false);
    console.log(JSON.stringify({ imported: true, exports: Object.keys(namespace).sort(),
      bot_entry: relative(botEntry), api_resolved_from_driver: relative(apiFromRoot),
      api_resolved_from_bot: relative(apiFromBot),
      same_api_realpath: fs.realpathSync(apiFromRoot) === fs.realpathSync(apiFromBot),
      prototype_extends_target_bot: Object.getPrototypeOf(SupalosaBot.prototype) === api.Bot.prototype,
      lifecycle_types_before_guards: lifecycleTypes,
      constructor_succeeded: true, instance_of_target_bot: instance instanceof api.Bot,
      context_is_unset: instance.context === undefined, country_argument: country,
      country_value_preserved: instance.country === country,
      requested_alliances: [], logging_argument: false, forbidden_calls: forbiddenCalls,
      constructor_scope: 'Default strategy and queue objects only; lifecycle methods are guarded, never invoked.' }));
  } catch (error) {
    console.log(JSON.stringify({ imported: false, error_name: error.name, error_code: error.code,
      error_message: String(error.message).split(process.cwd()).join('<installation>'),
      forbidden_calls: forbiddenCalls }));
  }
`);

const strictLog = path.join(installDir, 'strict-install.log');
let strictInstallation = { status: 'not_repeated_by_this_script' };
if (fs.existsSync(strictLog)) {
  const text = fs.readFileSync(strictLog, 'utf8');
  strictInstallation = {
    status: text.includes('ERESOLVE') ? 'failed_peer_resolution' : 'inspect_log',
    error_code: text.includes('ERESOLVE') ? 'ERESOLVE' : null,
    relevant_error: sanitize(text.split('npm error Fix the upstream')[0].trim()),
    note: 'Historical install command output; this script itself does not install dependencies.',
  };
}
const forbidden = deep.result?.forbidden_calls || [];
const loadChecksPassed = deep.process_exit_code === 0 && deep.timed_out === false
  && deep.result?.imported === true
  && deep.result.same_api_realpath === true
  && deep.result.instance_of_target_bot === true
  && deep.result.prototype_extends_target_bot === true
  && deep.result.context_is_unset === true
  && apiInstallations.length === 1 && apiInstallations[0].version === '0.79.0'
  && forbidden.length === 0;

const report = {
  evidence_kind: 'published_opponent_import_and_constructor_only',
  node_version: process.version,
  installation_lock_sha256: sha256(lockBytes),
  probe_script_sha256: sha256(fs.readFileSync(__filename)),
  package_versions: { api: apiPackage.version, opponent: botPackage.version },
  opponent_declared_peer_api: botPackage.peerDependencies['@chronodivide/game-api'],
  peer_range_includes_target: false,
  peer_range_status: 'Known pinned ^0.75.0 excludes pinned 0.79.0; no upstream support claim.',
  installation: {
    strict_attempt: strictInstallation,
    probe_only_peer_bypass: '--legacy-peer-deps',
    lifecycle_scripts_disabled: '--ignore-scripts',
    reproduce_install: 'npm ci --ignore-scripts --legacy-peer-deps --no-audit --no-fund',
    bypass_scope: 'Allows loading inspection of the pinned pair only; not compatibility certification.',
  },
  audited_api_artifact_hashes_match: true,
  opponent_lock_integrity_matches_recorded_package: true,
  installed_api_copies: apiInstallations,
  declared_main: botPackage.main,
  declared_main_exists: fs.existsSync(path.join(botDir, botPackage.main)),
  direct_bot_entry_sha256: sha256(fs.readFileSync(path.join(botDir, 'dist/bot/bot.js'))),
  native_bare_esm_import: bare,
  author_deep_esm_import_and_guarded_constructor: deep,
  load_only_checks_passed: loadChecksPassed,
  resources_initialized: false,
  game_created: false,
  lifecycle_methods_executed: false,
  engine_simulated: false,
  source_typechecked_or_recompiled: false,
  gameplay_compatibility_verified: false,
  scope: 'Expected bare-entry failure is recorded separately. Passing deep import and constructor checks does not validate onGameInit/Start/Tick/Event, game context, observations, actions, playback, strategy or performance.',
};
const output = path.join(root, 'docs/references/opponent-load-probe.json');
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (!loadChecksPassed) process.exitCode = 1;
