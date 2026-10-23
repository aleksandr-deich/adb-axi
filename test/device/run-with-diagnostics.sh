#!/usr/bin/env bash
set -euo pipefail

: "${ANDROID_SERIAL:?Name the reserved emulator}"
: "${GITHUB_WORKSPACE:?This wrapper runs on the Linux CI runner}"
diagnostics="$GITHUB_WORKSPACE/test-results/emulator"
mkdir -p "$diagnostics"

monitors=()
cleanup() {
  result=$?
  trap - EXIT INT TERM
  printf '%s test command exit %s\n' "$(date -u +%FT%TZ)" "$result" >> "$diagnostics/lifecycle.txt"
  # Separate process groups let cleanup also stop a monitor's sleep or sudo child.
  for pid in "${monitors[@]}"; do
    kill -- "-$pid" 2>/dev/null || true
  done
  for pid in "${monitors[@]}"; do
    code=0
    wait "$pid" 2>/dev/null || code=$?
    printf '%s monitor pid %s exit %s\n' "$(date -u +%FT%TZ)" "$pid" "$code" >> "$diagnostics/lifecycle.txt"
  done
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

printf '%s monitoring %s\n' "$(date -u +%FT%TZ)" "$ANDROID_SERIAL" > "$diagnostics/lifecycle.txt"

# A vanished emulator cannot answer the failure hook's retrospective logcat request.
setsid adb -s "$ANDROID_SERIAL" logcat -b all -v threadtime > "$diagnostics/logcat.txt" 2>&1 &
monitors+=("$!")
setsid sudo -n dmesg --follow --ctime > "$diagnostics/kernel.txt" 2>&1 &
monitors+=("$!")
setsid bash -s -- "$GITHUB_WORKSPACE" > "$diagnostics/host.txt" 2>&1 <<'MONITOR' &
while :; do
  date -u +%FT%TZ
  free -m
  df -h "$1"
  ps -eo pid,ppid,stat,pcpu,pmem,rss,args | grep -E '[q]emu-system|[/]emulator|[a]db( |$)' || true
  sleep 5
done
MONITOR
monitors+=("$!")
printf 'logcat=%s kernel=%s host=%s\n' "${monitors[@]}" >> "$diagnostics/lifecycle.txt"

( cd "$GITHUB_WORKSPACE" && npx vitest run --config vitest.device.config.ts )
