#!/usr/bin/env bash
# Public connection details only. Never print the creation key here.
lan_addresses() {
  local preferred='' candidates=''
  preferred=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") {print $(i+1); exit}}' || true)
  candidates=$(ip -o -4 addr show scope global 2>/dev/null | awk '$2 !~ /^(docker|br-|veth|virbr)/ {split($4,a,"/"); print a[1]}' || true)
  if [ -z "$candidates" ]; then candidates=$(hostname -I 2>/dev/null || true); fi
  printf '%s\n' "$preferred $candidates" | awk '{for(i=1;i<=NF;i++) {
    n=split($i,a,"."); valid=(n==4); for(j=1;j<=n;j++) if(a[j]!~/^[0-9]+$/ || a[j]>255) valid=0;
    private=(a[1]==10 || (a[1]==192 && a[2]==168) || (a[1]==172 && a[2]>=16 && a[2]<=31));
    if(valid && private && !seen[$i]++) print $i;
  }}'
}
show_connection_info() {
  local domain bind address first=1
  domain=$(sed -n 's/^COLLAB_DOMAIN=//p' .env 2>/dev/null | head -n 1 || true)
  bind=$(sed -n 's/^COLLAB_BIND=//p' .env 2>/dev/null | head -n 1 || true)
  if [ "$bind" = 127.0.0.1 ] && [ -n "$domain" ] && [ "$domain" != localhost ]; then
    printf 'Address for all PCs: https://%s\nBrowser connection check: https://%s/health\n' "$domain" "$domain"
    echo 'Internet mode: DNS, router forwarding and HTTPS must also be working.'
  else
    while IFS= read -r address; do
      if [ "$first" = 1 ]; then
        printf 'Address for all PCs (recommended): http://%s:1234\nBrowser connection check: http://%s:1234/health\n' "$address" "$address"
        first=0
      else printf 'Other possible local address: http://%s:1234\n' "$address"; fi
    done < <(lan_addresses)
    if [ "$first" = 1 ]; then echo 'No private IPv4 address found. Connect the host to your local network, then check hostname -I.'; fi
    echo 'Use the same LAN address in the host app and guest apps. Both PCs must be on the same network.'
    echo 'Only for a test on the server PC itself: http://127.0.0.1:1234'
    if [ "$bind" = 127.0.0.1 ]; then echo 'Port is configured for this PC only. Rerun setup and choose 1 for local-network sharing.'; fi
  fi
  echo 'In IDE-beta: Share project → PCs on the same network (or HTTPS internet mode) → Check server → Share this project.'
  echo 'Guests choose Join a project and paste an editor/viewer invitation; they do not need the server creation key.'
  echo 'Old localhost invitation? In the guest app, replace Connect to this server with the host LAN address.'
  printf 'Check again from any folder: bash %q status\n' "$PWD/server.sh"
}
