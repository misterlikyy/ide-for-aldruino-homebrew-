#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
. ./prerequisites.sh
compose_start() {
  if grep -q '^COLLAB_BIND=127.0.0.1$' .env 2>/dev/null && grep -Eq '^COLLAB_DOMAIN=.+\..+' .env; then
    as_root docker compose --profile internet up -d
  else as_root docker compose up -d; fi
}
action=${1:-}
if [ -z "$action" ]; then
  printf 'IDE-beta server\n1) Check server and show connection addresses\n2) Start\n3) Restart\n4) Stop (keep projects)\n5) Show private creation key\n6) Set up or update\n'
  read -r -p 'Choose 1–6 [1]: ' action
  action=${action:-1}
fi
case "$action" in
  1|status) exec bash ./status-server.sh ;;
  2|start) compose_start; exec bash ./status-server.sh --wait ;;
  3|restart) as_root docker compose --profile internet restart; exec bash ./status-server.sh --wait ;;
  4|stop) exec bash ./stop-server.sh ;;
  5|key)
    if [ ! -f .env ]; then echo 'No settings found. Run bash setup-server.sh first.' >&2; exit 1; fi
    echo 'Private creation key — enter it only in the host app. Guests use invitations:'
    sed -n 's/^COLLAB_CREATE_KEY=//p' .env ;;
  6|setup) exec bash ./setup-server.sh ;;
  --help|help) echo 'Run bash server.sh for a menu, or use: status | start | restart | stop | key | setup.' ;;
  *) echo 'Unknown command. Run bash server.sh --help.' >&2; exit 1 ;;
esac
