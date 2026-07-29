#!/bin/bash

set -euo pipefail

SCRIPT_NAME="cloudflare-fleet"
SCRIPT_DIR=""
RUNTIME_BASE=""
RUNTIME_DIR=""
SESSION_ID=""
SESSION_URL=""
SESSION_TARGET_ID=""
CHROME_PID=""
CHROME_LOG=""
BROKER_CONFIG=""
BROKER_ARGUMENTS=""
BROKER_DOMAIN=""
BROKER_LABEL=""
BROKER_LOG=""
BROKER_PID=""
BROKER_PLIST=""
BROKER_READY=""
BROKER_REPORTED_PID=""
BROKER_SERVICE_TARGET=""
BROKER_START_ATTEMPT=""
BROKER_START_ATTEMPTS=2
BROKER_STATE_LOG=""
PAGE_READY=""
WATCHER_LOG=""
WATCHER_PLIST=""
WATCHER_ARGUMENTS=""
WATCHER_LABEL=""
WATCHER_DOMAIN=""
WATCHER_SERVICE_TARGET=""
DEVTOOLS_PORT=""
CACHE_DIR=""
CACHE_RESULT=""
CACHE_HIT="false"
CACHE_LOADED_AT=""
CACHE_MODE="use"
CACHE_MODE_USE="use"
CACHE_MODE_FRESH="fresh"
CACHE_MODE_CLEAR="clear"
CHROME_BINARY="${CLOUDFLARE_FLEET_CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
CHROME_APP="${CLOUDFLARE_FLEET_CHROME_APP:-}"
NODE_BINARY=""
READ_ONLY=false
USE_CACHE=true
CLEAR_CACHE=false
DEBUG_PORT=""
SESSION_MODE="read/write"
SESSION_TITLE="Cloudflare Fleet | Read/write"
MODE_OPTION=""
MAX_DEBUG_PORT=65535
READY_ATTEMPTS=100
READY_INTERVAL_SECONDS="0.1"

show_help() {
    echo "NAME"
    echo "  $SCRIPT_NAME - launch the local Cloudflare fleet control plane"
    echo "SYNOPSIS"
    echo "  ./launch.sh [--read-only | --write] [--fresh | --clear-cache] [--debug-port PORT]"
    echo "OPTIONS"
    echo "  --read-only        Disable every write control"
    echo "  --write            Enable previewed and confirmed write controls (default)"
    echo "  --fresh            Bypass the cached snapshot for this launch"
    echo "  --clear-cache      Clear cached snapshots before loading live"
    echo "  --debug-port PORT  Open an isolated direct-client session with Chrome DevTools"
    echo "  -h, --help         Show this help text"
    echo "ENVIRONMENT"
    echo "  CLOUDFLARE_API_TOKEN   Required account-level Cloudflare API token"
    echo "  CLOUDFLARE_ACCOUNT_ID  Required Cloudflare account identifier"
    echo "  CLOUDFLARE_FLEET_CACHE_DIR Optional snapshot cache directory"
    echo "  CLOUDFLARE_FLEET_CHROME_APP Optional Chromium application bundle"
    echo "  CLOUDFLARE_FLEET_CHROME Optional path to a Chromium-compatible browser"
}

error() {
    echo "[ERR][$SCRIPT_NAME] $*" >&2
}

cleanup() {
    if [ -n "$BROKER_SERVICE_TARGET" ]; then
        /bin/launchctl bootout "$BROKER_SERVICE_TARGET" >/dev/null 2>&1 || true
    fi
    if [ -n "$BROKER_PID" ] && kill -0 "$BROKER_PID" 2>/dev/null; then
        kill "$BROKER_PID" 2>/dev/null || true
        wait "$BROKER_PID" 2>/dev/null || true
    fi

    if [ -n "$CHROME_PID" ] && kill -0 "$CHROME_PID" 2>/dev/null; then
        kill "$CHROME_PID" 2>/dev/null || true
        wait "$CHROME_PID" 2>/dev/null || true
    fi

    if [ -n "$RUNTIME_DIR" ] && [ -d "$RUNTIME_DIR" ]; then
        case "$RUNTIME_DIR" in
            "$RUNTIME_BASE"/cloudflare-fleet.*)
                /bin/rm -rf "$RUNTIME_DIR"
                ;;
            *)
                error "Refusing to remove unexpected runtime path: $RUNTIME_DIR"
                ;;
        esac
    fi
}

wait_for_broker_file() {
    local attempts
    local file_path

    file_path="$1"
    attempts=0
    while [ "$attempts" -lt "$READY_ATTEMPTS" ]; do
        if [ -s "$file_path" ]; then
            return 0
        fi
        if [ -n "$BROKER_PID" ] && ! kill -0 "$BROKER_PID" 2>/dev/null; then
            return 1
        fi
        attempts=$((attempts + 1))
        sleep "$READY_INTERVAL_SECONDS"
    done
    return 1
}

write_broker_config() {
    # shellcheck disable=SC2016
    "$NODE_BINARY" -e '
const crypto = require("node:crypto")
const fs = require("node:fs")
const [outputPath, accountId, cacheDir, readOnly, runtimeBase, runtimeDir, serviceTarget, sessionId] = process.argv.slice(1)
const config = {
  accountId,
  apiToken: process.env.CLOUDFLARE_API_TOKEN,
  cacheDir,
  readOnly: readOnly === "true",
  runtimeBase,
  runtimeDir,
  serviceTarget,
  sessionId,
  sessionSecret: crypto.randomBytes(32).toString("hex"),
}
fs.writeFileSync(outputPath, `${JSON.stringify(config)}\n`, { mode: 0o600 })
' \
        "$BROKER_CONFIG" "$CLOUDFLARE_ACCOUNT_ID" "$CACHE_DIR" "$READ_ONLY" \
        "$RUNTIME_BASE" "$RUNTIME_DIR" "$BROKER_SERVICE_TARGET" "$SESSION_ID"
    chmod 600 "$BROKER_CONFIG"
}

start_broker_service() {
    if ! /bin/launchctl bootstrap "$BROKER_DOMAIN" "$BROKER_PLIST" 2>>"$BROKER_LOG"; then
        return 1
    fi
    /bin/launchctl kickstart "$BROKER_SERVICE_TARGET" 2>>"$BROKER_LOG" || true
    BROKER_PID=""
    if wait_for_broker_file "$BROKER_READY"; then
        return 0
    fi
    /bin/launchctl print "$BROKER_SERVICE_TARGET" >"$BROKER_STATE_LOG" 2>&1 || true
    return 1
}

resolve_chrome_pid() {
    local profile_argument

    profile_argument="--user-data-dir=$RUNTIME_DIR/chrome-profile"
    CHROME_PID="$(ps -ax -o pid=,command= | awk -v profile="$profile_argument" 'index($0, profile) && pid == "" { pid = $1 } END { if (pid != "") print pid }')"
}

wait_for_devtools_port() {
    local attempts
    local port_file

    if [ -n "$DEBUG_PORT" ]; then
        DEVTOOLS_PORT="$DEBUG_PORT"
        return 0
    fi

    port_file="$RUNTIME_DIR/chrome-profile/DevToolsActivePort"
    attempts=0
    while [ "$attempts" -lt "$READY_ATTEMPTS" ]; do
        if [ -z "$CHROME_PID" ]; then
            resolve_chrome_pid
        fi
        if [ -s "$port_file" ]; then
            IFS= read -r DEVTOOLS_PORT < "$port_file"
            return 0
        fi
        if [ -n "$CHROME_PID" ] && ! kill -0 "$CHROME_PID" 2>/dev/null; then
            return 1
        fi
        attempts=$((attempts + 1))
        sleep "$READY_INTERVAL_SECONDS"
    done
    return 1
}

wait_for_session_ready() {
    local attempts
    local targets

    attempts=0
    while [ "$attempts" -lt "$READY_ATTEMPTS" ]; do
        if [ -z "$CHROME_PID" ]; then
            resolve_chrome_pid
        fi
        if [ -n "$CHROME_PID" ] && ! kill -0 "$CHROME_PID" 2>/dev/null; then
            return 1
        fi
        targets=""
        targets="$(curl -sS --max-time 1 "http://127.0.0.1:$DEVTOOLS_PORT/json/list" 2>/dev/null || true)"
        SESSION_TARGET_ID="$(printf '%s' "$targets" | jq -r --arg title "$SESSION_TITLE" --arg url "$SESSION_URL" 'first(.[] | select(.title == $title and .url == $url) | .id) // empty' 2>/dev/null || true)"
        if [ -n "$SESSION_TARGET_ID" ]; then
            return 0
        fi
        attempts=$((attempts + 1))
        sleep "$READY_INTERVAL_SECONDS"
    done
    return 1
}

start_session_watcher() {
    WATCHER_LOG="$RUNTIME_DIR/watcher.log"
    WATCHER_PLIST="$RUNTIME_DIR/watcher.plist"
    WATCHER_LABEL="com.j256.cloudflare-fleet.$SESSION_ID"
    WATCHER_DOMAIN="gui/$(id -u)"
    WATCHER_SERVICE_TARGET="$WATCHER_DOMAIN/$WATCHER_LABEL"
    WATCHER_ARGUMENTS="$(jq -cn --args '$ARGS.positional' \
        "$NODE_BINARY" "$SCRIPT_DIR/src/session-watcher.mjs" \
        "$DEVTOOLS_PORT" "$SESSION_TARGET_ID" "$SESSION_URL" \
        "$RUNTIME_DIR" "$RUNTIME_BASE" "$CACHE_DIR" "$SESSION_ID" "$CHROME_PID" \
        "$WATCHER_SERVICE_TARGET")"

    plutil -create xml1 "$WATCHER_PLIST"
    plutil -insert Label -string "$WATCHER_LABEL" "$WATCHER_PLIST"
    plutil -insert ProgramArguments -json "$WATCHER_ARGUMENTS" "$WATCHER_PLIST"
    plutil -insert RunAtLoad -bool true "$WATCHER_PLIST"
    plutil -insert KeepAlive -bool false "$WATCHER_PLIST"
    plutil -insert ProcessType -string Background "$WATCHER_PLIST"
    plutil -insert StandardOutPath -string "$WATCHER_LOG" "$WATCHER_PLIST"
    plutil -insert StandardErrorPath -string "$WATCHER_LOG" "$WATCHER_PLIST"
    chmod 600 "$WATCHER_PLIST"

    /bin/launchctl bootstrap "$WATCHER_DOMAIN" "$WATCHER_PLIST"
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --read-only)
            if [ "$MODE_OPTION" = "write" ]; then
                error "--read-only and --write cannot be combined"
                exit 2
            fi
            READ_ONLY=true
            MODE_OPTION="read-only"
            SESSION_MODE="read-only"
            SESSION_TITLE="Cloudflare Fleet | Read-only"
            shift
            ;;
        --write)
            if [ "$MODE_OPTION" = "read-only" ]; then
                error "--read-only and --write cannot be combined"
                exit 2
            fi
            READ_ONLY=false
            MODE_OPTION="write"
            SESSION_MODE="read/write"
            SESSION_TITLE="Cloudflare Fleet | Read/write"
            shift
            ;;
        --fresh)
            USE_CACHE=false
            shift
            ;;
        --clear-cache)
            CLEAR_CACHE=true
            USE_CACHE=false
            shift
            ;;
        --debug-port)
            if [ "$#" -lt 2 ]; then
                error "--debug-port requires a value"
                exit 2
            fi
            DEBUG_PORT="$2"
            shift 2
            ;;
        -h|--help)
            show_help
            exit 0
            ;;
        *)
            error "Unknown option: $1"
            exit 2
            ;;
    esac
done

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
    error "CLOUDFLARE_API_TOKEN is unset"
    exit 4
fi

if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
    error "CLOUDFLARE_ACCOUNT_ID is unset"
    exit 4
fi

if [ -z "$CHROME_APP" ]; then
    case "$CHROME_BINARY" in
        */Contents/MacOS/*)
            CHROME_APP="${CHROME_BINARY%%/Contents/MacOS/*}"
            ;;
    esac
fi

if [ -n "$CHROME_APP" ]; then
    if [ ! -d "$CHROME_APP" ]; then
        error "Chrome application bundle not found: $CHROME_APP"
        exit 3
    fi
elif [ ! -x "$CHROME_BINARY" ]; then
    error "Chrome executable not found: $CHROME_BINARY"
    exit 3
fi

if ! command -v jq >/dev/null 2>&1; then
    error "jq is required"
    exit 3
fi

if ! command -v curl >/dev/null 2>&1; then
    error "curl is required"
    exit 3
fi

if ! command -v plutil >/dev/null 2>&1; then
    error "plutil is required"
    exit 3
fi

if ! command -v node >/dev/null 2>&1; then
    error "Node.js is required"
    exit 3
fi
NODE_BINARY="$(command -v node)"
if ! "$NODE_BINARY" -e 'process.exit(typeof globalThis.fetch === "function" && typeof globalThis.AbortSignal?.timeout === "function" ? 0 : 1)'; then
    error "Node.js must provide built-in fetch and AbortSignal.timeout"
    exit 3
fi
if [ -n "$DEBUG_PORT" ] && ! "$NODE_BINARY" -e 'process.exit(typeof globalThis.WebSocket === "function" ? 0 : 1)'; then
    error "Debug sessions require a Node.js build with WebSocket"
    exit 3
fi

case "$DEBUG_PORT" in
    ""|*[!0-9]*)
        if [ -n "$DEBUG_PORT" ]; then
            error "--debug-port must be numeric"
            exit 2
        fi
        ;;
esac

if [ -n "$DEBUG_PORT" ] && { [ "$DEBUG_PORT" -lt 1 ] || [ "$DEBUG_PORT" -gt "$MAX_DEBUG_PORT" ]; }; then
    error "--debug-port must be between 1 and $MAX_DEBUG_PORT"
    exit 2
fi

if [ -n "$DEBUG_PORT" ] && curl -sS --max-time 1 "http://127.0.0.1:$DEBUG_PORT/json/version" >/dev/null 2>&1; then
    error "--debug-port $DEBUG_PORT is already in use"
    exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_BASE="${TMPDIR:-/tmp}"
RUNTIME_BASE="${RUNTIME_BASE%/}"

if [ -n "${CLOUDFLARE_FLEET_CACHE_DIR:-}" ]; then
    CACHE_DIR="${CLOUDFLARE_FLEET_CACHE_DIR%/}"
else
    CACHE_DIR="$(getconf DARWIN_USER_CACHE_DIR 2>/dev/null || true)"
    if [ -z "$CACHE_DIR" ]; then
        error "Could not resolve the macOS user cache directory"
        exit 3
    fi
    CACHE_DIR="${CACHE_DIR%/}/cloudflare-fleet"
fi

if [ "$CLEAR_CACHE" = true ]; then
    CACHE_MODE="$CACHE_MODE_CLEAR"
elif [ "$USE_CACHE" = false ]; then
    CACHE_MODE="$CACHE_MODE_FRESH"
else
    CACHE_MODE="$CACHE_MODE_USE"
fi

umask 077
RUNTIME_DIR="$(mktemp -d "$RUNTIME_BASE/cloudflare-fleet.XXXXXX")"
SESSION_ID="${RUNTIME_DIR##*.}"
SESSION_URL="file://$RUNTIME_DIR/index.html"
CHROME_LOG="$RUNTIME_DIR/chrome.log"
trap cleanup EXIT INT TERM

mkdir -p "$RUNTIME_DIR/src"
cp "$SCRIPT_DIR/index.html" "$RUNTIME_DIR/index.html"
cp "$SCRIPT_DIR/styles.css" "$RUNTIME_DIR/styles.css"
cp "$SCRIPT_DIR"/src/*.mjs "$RUNTIME_DIR/src/"

CACHE_RESULT="$("$NODE_BINARY" "$SCRIPT_DIR/src/cache-store.mjs" prepare \
    "$CACHE_DIR" "$CLOUDFLARE_ACCOUNT_ID" "$RUNTIME_DIR/cache.js" "$CACHE_MODE")"
CACHE_HIT="$(printf '%s' "$CACHE_RESULT" | jq -r '.cacheHit')"
CACHE_LOADED_AT="$(printf '%s' "$CACHE_RESULT" | jq -r '.loadedAt // empty')"

if [ "$CACHE_HIT" = true ]; then
    echo "[INF][$SCRIPT_NAME] Cached snapshot $CACHE_LOADED_AT will render immediately; full refresh is explicit"
elif [ "$CACHE_MODE" = "$CACHE_MODE_CLEAR" ]; then
    echo "[INF][$SCRIPT_NAME] Cached snapshots cleared; loading live state"
elif [ "$CACHE_MODE" = "$CACHE_MODE_FRESH" ]; then
    echo "[INF][$SCRIPT_NAME] Cache bypassed; loading live state"
fi

if [ -z "$DEBUG_PORT" ]; then
    BROKER_CONFIG="$RUNTIME_DIR/broker-config.json"
    BROKER_LOG="$RUNTIME_DIR/broker.log"
    BROKER_PLIST="$RUNTIME_DIR/broker.plist"
    BROKER_READY="$RUNTIME_DIR/broker-ready.json"
    BROKER_STATE_LOG="$RUNTIME_DIR/broker-state.log"
    PAGE_READY="$RUNTIME_DIR/page-ready.json"
    BROKER_LABEL="com.j256.cloudflare-fleet.broker.$SESSION_ID"
    BROKER_DOMAIN="gui/$(id -u)"
    BROKER_SERVICE_TARGET="$BROKER_DOMAIN/$BROKER_LABEL"

    BROKER_ARGUMENTS="$(jq -cn --args '$ARGS.positional' \
        "$NODE_BINARY" "$SCRIPT_DIR/src/session-broker.mjs" "$BROKER_CONFIG")"
    plutil -create xml1 "$BROKER_PLIST"
    plutil -insert Label -string "$BROKER_LABEL" "$BROKER_PLIST"
    plutil -insert ProgramArguments -json "$BROKER_ARGUMENTS" "$BROKER_PLIST"
    plutil -insert RunAtLoad -bool true "$BROKER_PLIST"
    plutil -insert KeepAlive -bool false "$BROKER_PLIST"
    plutil -insert ProcessType -string Background "$BROKER_PLIST"
    plutil -insert StandardOutPath -string "$BROKER_LOG" "$BROKER_PLIST"
    plutil -insert StandardErrorPath -string "$BROKER_LOG" "$BROKER_PLIST"
    chmod 600 "$BROKER_PLIST"

    BROKER_START_ATTEMPT=1
    BROKER_STARTED=false
    while [ "$BROKER_START_ATTEMPT" -le "$BROKER_START_ATTEMPTS" ]; do
        /bin/rm -f "$BROKER_CONFIG" "$BROKER_READY"
        write_broker_config
        if start_broker_service; then
            BROKER_STARTED=true
            break
        fi
        /bin/launchctl bootout "$BROKER_SERVICE_TARGET" >/dev/null 2>&1 || true
        BROKER_PID=""
        if [ "$BROKER_START_ATTEMPT" -lt "$BROKER_START_ATTEMPTS" ]; then
            error "Broker activation attempt $BROKER_START_ATTEMPT failed; retrying"
            sleep "$READY_INTERVAL_SECONDS"
        fi
        BROKER_START_ATTEMPT=$((BROKER_START_ATTEMPT + 1))
    done

    if [ "$BROKER_STARTED" != true ]; then
        error "The loopback session broker did not start"
        if [ -s "$BROKER_LOG" ]; then
            tail -n 12 "$BROKER_LOG" >&2
        fi
        if [ -s "$BROKER_STATE_LOG" ]; then
            awk '/state =|pid =|last exit code/' "$BROKER_STATE_LOG" >&2 || true
        fi
        exit 5
    fi

    SESSION_URL="$(jq -r '.sessionUrl // empty' "$BROKER_READY")"
    BROKER_REPORTED_PID="$(jq -r '.pid // empty' "$BROKER_READY")"
    case "$BROKER_REPORTED_PID" in
        ""|*[!0-9]*)
            error "The loopback session broker reported an invalid process identifier"
            exit 5
            ;;
    esac
    BROKER_PID="$BROKER_REPORTED_PID"
    case "$SESSION_URL" in
        http://127.0.0.1:*/session/"$SESSION_ID"/index.html)
            ;;
        *)
            error "The loopback session broker reported an unexpected URL"
            exit 5
            ;;
    esac

    echo "[INF][$SCRIPT_NAME] Opening protected $SESSION_MODE session in an existing Chrome tab"
    if [ -n "$CHROME_APP" ]; then
        /usr/bin/open -a "$CHROME_APP" "$SESSION_URL"
    else
        nohup "$CHROME_BINARY" "$SESSION_URL" </dev/null >/dev/null 2>&1 &
    fi
    if ! wait_for_broker_file "$PAGE_READY"; then
        error "Chrome did not initialize the dashboard tab"
        if [ -s "$BROKER_LOG" ]; then
            tail -n 12 "$BROKER_LOG" >&2
        fi
        exit 5
    fi

    BROKER_PID=""
    trap - EXIT INT TERM
    echo "[INF][$SCRIPT_NAME] Session ready; the launcher has exited and the tab remains $SESSION_MODE"
    exit 0
fi

AUTH_JSON=""
AUTH_JSON="$(jq -cn \
    --arg apiToken "$CLOUDFLARE_API_TOKEN" \
    --arg accountId "$CLOUDFLARE_ACCOUNT_ID" \
    --argjson readOnly "$READ_ONLY" \
    '{apiToken:$apiToken,accountId:$accountId,readOnly:$readOnly}')"
printf 'window.__CLOUDFLARE_FLEET_AUTH__ = Object.freeze(%s)\n' "$AUTH_JSON" > "$RUNTIME_DIR/auth.js"
unset AUTH_JSON
chmod 600 "$RUNTIME_DIR/auth.js"

CHROME_ARGS=(
    "--user-data-dir=$RUNTIME_DIR/chrome-profile"
    "--new-window"
    "--disable-web-security"
    "--allow-file-access-from-files"
    "--disable-background-networking"
    "--disable-component-update"
    "--disable-extensions"
    "--disable-sync"
    "--no-default-browser-check"
    "--no-first-run"
    "--remote-debugging-address=127.0.0.1"
)

if [ -n "$DEBUG_PORT" ]; then
    CHROME_ARGS+=("--remote-debugging-port=$DEBUG_PORT")
else
    CHROME_ARGS+=("--remote-debugging-port=0")
fi

CHROME_ARGS+=("$SESSION_URL")

echo "[INF][$SCRIPT_NAME] Opening protected $SESSION_MODE debug session in an isolated Chrome window"
if [ -n "$CHROME_APP" ]; then
    /usr/bin/open -n -a "$CHROME_APP" --stdin /dev/null --stdout "$CHROME_LOG" --stderr "$CHROME_LOG" --args "${CHROME_ARGS[@]}"
else
    nohup "$CHROME_BINARY" "${CHROME_ARGS[@]}" </dev/null >"$CHROME_LOG" 2>&1 &
    CHROME_PID=$!
fi

if ! wait_for_devtools_port; then
    error "Chrome did not expose its local debugging endpoint"
    exit 5
fi

resolve_chrome_pid

if [ -z "$CHROME_PID" ]; then
    error "Chrome process could not be resolved for the session watcher"
    exit 5
fi

if ! wait_for_session_ready; then
    error "Chrome did not initialize the dashboard"
    if [ -s "$CHROME_LOG" ]; then
        tail -n 12 "$CHROME_LOG" >&2
    fi
    exit 5
fi

/bin/rm "$RUNTIME_DIR/auth.js"
start_session_watcher
if [ -n "$CHROME_PID" ]; then
    disown "$CHROME_PID" 2>/dev/null || true
fi
CHROME_PID=""
trap - EXIT INT TERM

echo "[INF][$SCRIPT_NAME] Session ready; the launcher has exited and the page remains $SESSION_MODE"
