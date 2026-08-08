#!/bin/sh
# Persistent adb server for wireless debugging.
#
# ADB=1 ./dev.sh (and other host-network clients) talk to this container's
# server on port 5037, so `adb connect` survives across invocations.
#
# Usage:
#   ./scripts/adb-server.sh start|stop|status|restart
set -eu

cd "$(dirname "$0")/.."

NAME=funkot-player-adb
IMAGE=funkot-player-dev
ANDROID_HOME_VOL=funkot-player-android-home
ADB_PORT=5037

usage() {
    echo "usage: $0 start|stop|status|restart" >&2
}

ensure_image() {
    if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
        docker build -t "$IMAGE" .
    fi
}

container_exists() {
    docker inspect "$NAME" >/dev/null 2>&1
}

container_running() {
    [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null || echo false)" = true ]
}

# Probe TCP only. Do not run `adb` here: a client that cannot reach a server
# will start its own on host network and race with funkot-player-adb.
port_open() {
    python3 -c "import socket; s=socket.create_connection(('127.0.0.1', $ADB_PORT), 1); s.close()" \
        >/dev/null 2>&1
}

wait_for_adb() {
    i=0
    while [ "$i" -lt 20 ]; do
        if ! container_running; then
            echo "adb server container exited before becoming ready" >&2
            docker logs "$NAME" 2>&1 | tail -n 20 >&2 || true
            return 1
        fi
        if port_open; then
            return 0
        fi
        i=$((i + 1))
        sleep 0.25
    done
    echo "adb server did not become ready on port $ADB_PORT" >&2
    return 1
}

create_or_start() {
    if container_running; then
        return 0
    fi
    if container_exists; then
        docker start "$NAME" >/dev/null
        return 0
    fi
    # Parallel cold starts can race on --name; if create loses, start the winner.
    if ! docker run -d --name "$NAME" \
        --network host \
        -v "$ANDROID_HOME_VOL":/root/.android \
        "$IMAGE" adb nodaemon server >/dev/null 2>&1; then
        if container_exists; then
            docker start "$NAME" >/dev/null
        else
            echo "failed to create $NAME" >&2
            return 1
        fi
    fi
}

do_start() {
    ensure_image
    if container_running && port_open; then
        return 0
    fi
    create_or_start
    wait_for_adb
    if ! container_running; then
        echo "adb server container is not running after start" >&2
        return 1
    fi
}

do_stop() {
    if container_exists; then
        docker stop "$NAME" >/dev/null
    fi
}

do_status() {
    if container_running; then
        echo "Running"
        # Server already holds 5037, so this client will not spawn another.
        docker run --rm --network host \
            -v "$ANDROID_HOME_VOL":/root/.android \
            "$IMAGE" adb devices -l || true
    elif container_exists; then
        echo "Stopped"
    else
        echo "Absent"
    fi
}

case "${1:-}" in
    start) do_start ;;
    stop) do_stop ;;
    status) do_status ;;
    restart)
        do_stop
        do_start
        ;;
    *)
        usage
        exit 1
        ;;
esac
