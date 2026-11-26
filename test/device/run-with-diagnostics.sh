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

# Keep logs from before the disconnect and reattach as soon as the device returns.
setsid bash -s > "$diagnostics/logcat.txt" 2>&1 <<'MONITOR' &
while :; do
  if adb -s "$ANDROID_SERIAL" wait-for-device; then
    adb -s "$ANDROID_SERIAL" logcat -b all -v threadtime
  fi
  sleep 1
done
MONITOR
monitors+=("$!")

setsid bash -s -- "$diagnostics" > "$diagnostics/boot.txt" 2>&1 <<'MONITOR' &
previous_id=
previous_reason=
while :; do
  if sample=$(adb -s "$ANDROID_SERIAL" shell -T 'cat /proc/sys/kernel/random/boot_id && getprop sys.boot.reason' 2>/dev/null); then
    mapfile -t boot <<< "$sample"
    boot_id=${boot[0]}
    reason=${boot[1]:-unknown}
    if [[ $boot_id =~ ^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$ ]]; then
      # Android may refine the reason after adb first reconnects.
      if [[ $boot_id != "$previous_id" || $reason != "$previous_reason" ]]; then
        printf '%s boot %s sys.boot.reason=%s\n' "$(date -u +%FT%TZ)" "$boot_id" "$reason"
      fi
      if [[ -n $previous_id && $boot_id != "$previous_id" ]]; then
        pstore="$1/pstore-$boot_id.txt"
        if ! adb -s "$ANDROID_SERIAL" shell -T 'cat /sys/fs/pstore/console-ramoops*' > "$pstore"; then
          # Debug emulator images provide su. Unlike adb root, it does not restart adbd
          # and drop the transport that the tests use.
          adb -s "$ANDROID_SERIAL" shell -T "su 0 sh -c 'cat /sys/fs/pstore/console-ramoops*'" > "$pstore" || true
        fi
      fi
      previous_id=$boot_id
      previous_reason=$reason
    fi
  fi
  sleep 2
done
MONITOR
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
printf 'logcat=%s boot=%s kernel=%s host=%s\n' "${monitors[@]}" >> "$diagnostics/lifecycle.txt"

( cd "$GITHUB_WORKSPACE" && npx vitest run --config vitest.device.config.ts )
