#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  printf 'usage: %s https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev\n' "$0" >&2
  exit 2
fi

worker_url="${1%/}"
worker_url_pattern='^https://[A-Za-z0-9.-]+\.workers\.dev$'
if [[ ! "$worker_url" =~ $worker_url_pattern ]]; then
  printf 'error: expected an HTTPS workers.dev base URL, got: %s\n' "$worker_url" >&2
  exit 2
fi

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
config_file="$repo_root/assets/js/analytics-config.js"
endpoint="$worker_url/api/event"
temporary_file=$(mktemp)
trap 'rm -f "$temporary_file"' EXIT

awk -v endpoint="$endpoint" '
  /endpoint: "[^"]*"/ {
    sub(/endpoint: "[^"]*"/, "endpoint: \"" endpoint "\"")
    replaced = 1
  }
  { print }
  END { if (!replaced) exit 3 }
' "$config_file" > "$temporary_file"

mv "$temporary_file" "$config_file"
trap - EXIT
printf 'configured analytics endpoint: %s\n' "$endpoint"
