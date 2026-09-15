import { registerHooks } from 'node:module';
import { createHash } from 'node:crypto';

// A read-only export is appended to the pinned module. No engine method, timing,
// state or action is changed. Only the runner imports this diagnostic capability.
const expected='2c6937c165ffc822eb6db7d8a72847fe650394b0ba46d5bd92693e578e0400cb';
registerHooks({load(url,context,nextLoad){
  const result=nextLoad(url,context);
  if(!url.endsWith('/@chronodivide/game-api/dist/index.js')) return result;
  const source=typeof result.source==='string'?result.source:Buffer.from(result.source).toString('utf8');
  if(createHash('sha256').update(source).digest('hex')!==expected) throw new Error('Pinned engine diagnostics source hash mismatch');
  return {...result,source:source+`\nexport function warbookReadStopState(instance) {
    const game = _GameInstanceApi_game.get(instance);
    const turnManager = _GameInstanceApi_turnMgr.get(instance);
    if (!game || !turnManager) throw new Error('Unknown game instance');
    return { source: 'pinned-engine-readonly-v1', status: GameStatus[game.status], turnManagerError: turnManager.getErrorState() };
  }\n`};
}});
