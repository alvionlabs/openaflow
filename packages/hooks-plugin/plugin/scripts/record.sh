#!/bin/sh
# Appends one line per Claude Code hook event to $OPENAFLOW_HOOKS_DIR/$OPENAFLOW_RUN.jsonl.
#   {"v":1,"at":<ms>,"payload":<stdin JSON>}
# A payload over 64 KB becomes {"v":1,"at":<ms>,"cut":true,"event":"...","session":"..."}.
# Rules: POSIX sh only; never writes to stdout (a SessionStart stdout becomes model context);
# always exits 0; writes nothing unless the marker is a lowercase UUID v4 and the folder is absolute.
# The file holds every prompt and tool input, so only the user may read it: folder 0700, file 0600 (no-ops on Windows).

LIMIT=65536

record() {
  marker=${OPENAFLOW_RUN-}
  case $marker in
    [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
    *) return 0 ;;
  esac

  dir=${OPENAFLOW_HOOKS_DIR-}
  # A Windows path may use backslashes; sh writes to it with slashes.
  dir=$(printf '%s' "$dir" | tr '\\' '/')
  case $dir in
    /* | [A-Za-z]:/*) ;;
    *) return 0 ;;
  esac

  payload=$(cat | tr -d '\r\n')
  at=$(date +%s%3N)
  case $at in
    '' | *[!0-9]*) at=$(date +%s)000 ;;
  esac

  if [ -z "$payload" ]; then
    line="{\"v\":1,\"at\":$at,\"payload\":null}"
  elif [ "$(printf '%s' "$payload" | wc -c | tr -d ' ')" -gt "$LIMIT" ]; then
    event=$(printf '%s' "$payload" | grep -o '"hook_event_name" *: *"[^"]*"' | head -n 1 | sed 's/^[^:]*: *"//; s/"$//' | tr -d '\\')
    session=$(printf '%s' "$payload" | grep -o '"session_id" *: *"[^"]*"' | head -n 1 | sed 's/^[^:]*: *"//; s/"$//' | tr -d '\\')
    line="{\"v\":1,\"at\":$at,\"cut\":true,\"event\":\"$event\",\"session\":\"$session\"}"
  else
    line="{\"v\":1,\"at\":$at,\"payload\":$payload}"
  fi

  umask 077
  mkdir -p "$dir" || return 0
  # A folder made before this rule may be looser. Once per run, not per event: one more process only on the first line.
  [ -e "$dir/$marker.jsonl" ] || chmod 700 "$dir"
  printf '%s\n' "$line" >>"$dir/$marker.jsonl"
}

record >/dev/null 2>&1
exit 0
