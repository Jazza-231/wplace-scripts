#!/usr/bin/env bash
set -euo pipefail

SRC="/mnt/c/Users/jazza/Downloads/wplace"
DST="hetzner-sbox:wplace/"
BW_TOTAL=14000
SSH_OPTS="-i ~/.ssh/id_ed25519 -p 23"

START_FROM="${1:-1}"

cd "$SRC"

for f in $(ls tiles-*.7z | sort -V); do
  num=${f#tiles-}
  num=${num%.7z}
  if (( num >= START_FROM )); then
    echo "Uploading $f ..."
    rsync -av --info=progress2 \
      --partial --append-verify --timeout=300 \
      --bwlimit="$BW_TOTAL" -e "ssh $SSH_OPTS" \
      "$f" "$DST"
  fi
done

echo "All files uploaded."