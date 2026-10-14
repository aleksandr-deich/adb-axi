set -eu

: "${ANDROID_SERIAL:?Disposable CI target must be explicitly selected}"
: "${ADB_AXI_BIN:?Use the installed packed CLI}"

mkdir -p test-results/diagnostic
home=$(mktemp -d)
trap 'rm -rf "$home"' EXIT
export ADB_AXI_HOME="$home"
exec > test-results/diagnostic/older-api-diagnostic.txt 2>&1

axi() {
  printf '\n$ adb-axi'
  printf ' %s' "$@"
  printf ' --device %s --json\n' "$ANDROID_SERIAL"
  if "$ADB_AXI_BIN" "$@" --device "$ANDROID_SERIAL" --json; then
    printf '# CLI exit 0\n'
  else
    status=$?
    printf '# CLI exit %s\n' "$status"
    return "$status"
  fi
}

facts() {
  printf '\n# facts: %s\n' "$1"
  axi shell "pm path --user 0 dev.probe; pm path dev.probe; dumpsys package dev.probe | grep -E 'Package \\[dev.probe\\]|versionCode=|versionName=|pkgFlags=|flags=|User 0:' || true"
  axi shell "ps -A -o PID,UID,NAME,STAT | awk 'NR == 1 || \$3 == \"dev.probe\" || \$3 == \"[dev.probe]\"'"
  axi shell "dumpsys activity processes | grep -E 'ProcessRecord.*:dev[.]probe/' || true"
}

window() {
  printf '\n# window: %s\n' "$1"
  axi shell "dumpsys window | grep -E 'mCurrentFocus=|mFocusedApp=' || true"
  axi shell "dumpsys input | grep -A 5 -E 'FocusedApplication|FocusedWindow' || true"
  axi shell "dumpsys activity activities | grep -E 'mResumedActivity|topResumedActivity|mFocusedActivity|ResumedActivity|ActivityRecord.*dev[.]probe|TaskRecord.*dev[.]probe' || true"
  axi shell "ps -A -o PID,UID,NAME,STAT | awk 'NR == 1 || \$3 == \"dev.probe\" || \$3 == \"[dev.probe]\"'"
}

seed() {
  axi app install test/fixtures/apk/probe-debug.apk --clean-data
  axi logs mark standalone-seed
  axi app start dev.probe --fresh
  axi shell 'am start -n dev.probe/.MainActivity --es probe inc'
  axi shell 'am start -n dev.probe/.MainActivity --es probe write'
  axi wait log 'event=write saved=1 volatile=1 rows=1 ' --since standalone-seed
  axi data db dev.probe 'SELECT id, text FROM notes'
}

axi wait boot
axi shell 'getprop ro.build.version.sdk; getprop ro.build.version.release'
for variant in cli-running cli-stopped platform-global; do
  printf '\n# standalone keep-data variant: %s\n' "$variant"
  seed
  if [ "$variant" = cli-stopped ]; then
    axi app stop dev.probe
  fi
  facts before-uninstall
  if [ "$variant" = platform-global ]; then
    if axi shell 'pm uninstall -k dev.probe'; then :; else :; fi
  else
    if axi app uninstall dev.probe --keep-data; then :; else :; fi
  fi
  facts immediately-after-uninstall
  axi app info dev.probe
  axi app install test/fixtures/apk/probe-debug.apk
  axi logs mark standalone-reinstall
  axi app start dev.probe --fresh
  axi shell 'am start -n dev.probe/.MainActivity --es probe state'
  axi wait log 'event=state .*rows=1 ' --since standalone-reinstall
  axi data db dev.probe 'SELECT id, text FROM notes'
  facts after-same-signed-reinstall
done

printf '\n# standalone negative-window counterfactual\n'
seed
window running
axi app stop dev.probe
window immediately-after-stop
axi shell 'input keyevent KEYCODE_HOME'
window after-explicit-home
axi app start dev.probe --fresh
window running-before-release
axi app install test/fixtures/apk/probe-release.apk --clean-data
window immediately-after-release-replacement
axi shell 'input keyevent KEYCODE_HOME'
window release-after-explicit-home
axi app info dev.probe
axi app install test/fixtures/apk/probe-debug.apk --clean-data
