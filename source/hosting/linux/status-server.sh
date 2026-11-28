#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
. ./prerequisites.sh
. ./server-addresses.sh
if [ ! -f .env ]; then echo 'Server settings (.env) are missing. Run bash setup-server.sh in this folder first.' >&2; exit 1; fi
if ! command -v docker >/dev/null 2>&1; then echo 'Docker is missing. Run bash setup-server.sh to install the server dependencies.' >&2; exit 1; fi
if ! as_root docker compose ps; then
  echo 'Could not check Docker. Try sudo systemctl start docker, then run this check again.' >&2; exit 1
fi
attempts=1; if [ "${1:-}" = --wait ]; then attempts=20; echo 'Waiting for the server to answer…'; fi
ready=0
for ((attempt=0; attempt<attempts; attempt++)); do
  if as_root docker compose exec -T collaboration node -e "fetch('http://127.0.0.1:1234/health',{signal:AbortSignal.timeout(2000)}).then(async r=>{const j=await r.json();process.exit(r.ok&&j.ok===true&&j.protocol===1?0:1)}).catch(()=>process.exit(1))" 2>/dev/null; then ready=1; break; fi
  if ((attempt+1<attempts)); then sleep 1; fi
done
if [ "$ready" = 0 ]; then
  echo 'The server is not responding yet. Start it with bash server.sh start.' >&2
  echo 'For details: sudo docker compose logs --tail=50 collaboration' >&2; exit 1
fi
printf '\nServer is running and responding.\n\n'
show_connection_info
echo 'This verifies the server container. Open the browser connection-check address on the guest PC to test its network access.'
