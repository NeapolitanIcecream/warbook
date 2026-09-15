#!/bin/zsh
set -e
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd -- "$(dirname -- "$0")/.."
mkdir -p work
entry="http://127.0.0.1:8642"
if ! curl -fsS --max-time 1 "$entry/warbook/health" >/dev/null 2>&1; then
  OFFLINE="${OFFLINE:-1}" nohup npm run play >work/player-server.log 2>&1 </dev/null &
  for attempt in {1..45}; do
    if curl -fsS --max-time 1 "$entry/warbook/health" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
fi
if curl -fsS --max-time 1 "$entry/warbook/health" >/dev/null 2>&1; then
  open "$entry"
else
  print "Warbook 未能启动。运行记录：$(pwd)/work/player-server.log"
  exit 1
fi
