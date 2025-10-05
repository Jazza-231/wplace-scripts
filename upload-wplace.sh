#!/usr/bin/env bash
set -euo pipefail

SRC="/mnt/c/Users/jazza/Downloads/wplace"
DST="hetzner-sbox:wplace/"
BW_TOTAL=14000
SSH_OPTS="-i ~/.ssh/id_ed25519 -p 23"

START_FROM="${1:-1}"
if ! [[ $START_FROM =~ ^[0-9]+$ ]]; then
  echo "START_FROM must be a number"
  exit 1
fi

shopt -s nullglob
cd "$SRC"

mapfile -t files < <(printf '%s\n' tiles-[0-9]*.7z | grep -E '^tiles-[0-9]+\.7z$' | sort -V)

if ((${#files[@]} == 0)); then
  echo "No matching files."
  exit 0
fi

for f in "${files[@]}"; do
  fname=$(basename -- "$f")
  num=${fname#tiles-}
  num=${num%.7z}
  if [[ $num =~ ^[0-9]+$ ]] && (( num >= START_FROM )); then
    echo "Uploading $fname ..."
    rsync -av --info=progress2 \
      --partial --append-verify --timeout=300 \
      --bwlimit="$BW_TOTAL" -e "ssh $SSH_OPTS" \
      "$fname" "$DST"
  fi
done

echo "All files uploaded."

