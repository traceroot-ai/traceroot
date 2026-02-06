#!/bin/bash
# Goose migration helper for ClickHouse
# Usage: ./goose.sh [up|down|status|create NAME]

set -e

CLICKHOUSE_HOST=${CLICKHOUSE_HOST:-localhost}
CLICKHOUSE_PORT=${CLICKHOUSE_PORT:-9000}
CLICKHOUSE_USER=${CLICKHOUSE_USER:-clickhouse}
CLICKHOUSE_PASSWORD=${CLICKHOUSE_PASSWORD:-clickhouse}
CLICKHOUSE_DATABASE=${CLICKHOUSE_DATABASE:-default}

GOOSE_DRIVER="clickhouse"
GOOSE_DBSTRING="tcp://${CLICKHOUSE_HOST}:${CLICKHOUSE_PORT}?username=${CLICKHOUSE_USER}&password=${CLICKHOUSE_PASSWORD}&database=${CLICKHOUSE_DATABASE}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATIONS_DIR="${SCRIPT_DIR}/migrations"

case "$1" in
    up)
        goose -dir "$MIGRATIONS_DIR" "$GOOSE_DRIVER" "$GOOSE_DBSTRING" up
        ;;
    down)
        goose -dir "$MIGRATIONS_DIR" "$GOOSE_DRIVER" "$GOOSE_DBSTRING" down
        ;;
    status)
        goose -dir "$MIGRATIONS_DIR" "$GOOSE_DRIVER" "$GOOSE_DBSTRING" status
        ;;
    create)
        if [ -z "$2" ]; then
            echo "Usage: ./goose.sh create NAME"
            exit 1
        fi
        goose -dir "$MIGRATIONS_DIR" "$GOOSE_DRIVER" "$GOOSE_DBSTRING" create "$2" sql
        ;;
    *)
        echo "Usage: ./goose.sh [up|down|status|create NAME]"
        echo ""
        echo "Commands:"
        echo "  up      - Run all pending migrations"
        echo "  down    - Roll back the last migration"
        echo "  status  - Show migration status"
        echo "  create  - Create a new migration file"
        exit 1
        ;;
esac
