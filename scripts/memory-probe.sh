#!/usr/bin/env bash
# memory-probe.sh — 取樣 macOS process 記憶體指標，輸出 CSV
#
# Usage:
#   scripts/memory-probe.sh <pid> [interval_sec=300] [duration_sec=infinite] > probe.csv
#
# 欄位：ts, footprint_mb, iokit_swapped_mb, writable_swapped_mb, fd_count, rss_kb
#
# 範例（驗收 agent-tail 修復是否生效）：
#   bun /Users/pc035860/.bun/bin/agent-tail claude <session-uuid> --all &
#   PID=$!
#   scripts/memory-probe.sh "$PID" 300 > /tmp/probe-$(date +%Y%m%d-%H%M).csv
#   # ...跑 7 小時或想看的時間長度，Ctrl-C 結束 probe 或 agent-tail

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <pid> [interval_sec=300] [duration_sec]" >&2
  exit 1
fi

PID="$1"
INTERVAL="${2:-300}"
DURATION="${3:-}"

if ! kill -0 "$PID" 2>/dev/null; then
  echo "Error: PID $PID does not exist or is not accessible" >&2
  exit 1
fi

# 把帶單位的字串轉成 MB（接受 "16.9G" / "284M" / "12K"）
to_mb() {
  awk -v s="$1" 'BEGIN {
    if (match(s, /[0-9]+(\.[0-9]+)?/) == 0) { print "NA"; exit }
    n = substr(s, RSTART, RLENGTH) + 0
    unit = substr(s, RSTART + RLENGTH, 1)
    if (unit == "G") n *= 1024
    else if (unit == "K") n /= 1024
    else if (unit == "B") n /= (1024 * 1024)
    printf "%.2f", n
  }'
}

echo "ts,footprint_mb,iokit_swapped_mb,writable_swapped_mb,fd_count,rss_kb"

START_TS=$(date +%s)
while kill -0 "$PID" 2>/dev/null; do
  TS=$(date -Iseconds 2>/dev/null || date +%FT%T)

  FP_RAW=$(/usr/bin/footprint -p "$PID" 2>/dev/null \
    | awk '/Footprint:/ {print $3 $4; exit}' || true)
  FP_MB=$(to_mb "${FP_RAW:-0}")

  VMS=$(vmmap -summary "$PID" 2>/dev/null || true)

  # IOAccelerator 行：第 5 欄是 SWAPPED SIZE
  IOKIT_RAW=$(echo "$VMS" \
    | awk '/^IOAccelerator / && !/reserved/ {print $5; exit}')
  IOKIT_MB=$(to_mb "${IOKIT_RAW:-0}")

  # Writable regions 摘要行：抓 swapped_out=<size>
  WRSWAP_RAW=$(echo "$VMS" \
    | awk '/^Writable regions/ {
        for (i = 1; i <= NF; i++)
          if ($i ~ /swapped_out=/) { sub(/.*=/, "", $i); print $i; exit }
      }')
  WRSWAP_MB=$(to_mb "${WRSWAP_RAW:-0}")

  FD=$(lsof -p "$PID" 2>/dev/null | wc -l | tr -d ' ')
  RSS=$(ps -o rss= -p "$PID" 2>/dev/null | tr -d ' ')

  printf '%s,%s,%s,%s,%s,%s\n' \
    "$TS" "${FP_MB:-NA}" "${IOKIT_MB:-NA}" "${WRSWAP_MB:-NA}" \
    "${FD:-NA}" "${RSS:-NA}"

  # 達到指定 duration 結束
  if [[ -n "$DURATION" ]]; then
    NOW=$(date +%s)
    if (( NOW - START_TS >= DURATION )); then
      break
    fi
  fi

  sleep "$INTERVAL"
done
