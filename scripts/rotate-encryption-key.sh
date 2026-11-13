#!/bin/sh
# Move stored provider keys and Slack tokens to a new encryption key, then write the
# new key to .env. Run through `make rotate-encryption-key` from the repository root.
#
# Safe to repeat: the new key is kept in a private pending file until .env has it, so a
# run that stopped part-way resumes with the same key. The database change is a single
# transaction, so a failure leaves both the data and .env as they were.
set -eu
umask 077

ENV_FILE=.env
PENDING=.env.encryption-key.pending
BACKUP=.env.encryption-key.previous
COMPOSE="${ROTATE_COMPOSE:-docker compose -f docker-compose.prod.yml}"

if [ -L "$ENV_FILE" ]; then
	echo "rotate-encryption-key: $ENV_FILE is a symlink. Refusing to write secrets through it -- replace it with a regular file." >&2
	exit 1
fi
if [ ! -f "$ENV_FILE" ]; then
	echo "rotate-encryption-key: no $ENV_FILE here. Run make prod-lite first." >&2
	exit 1
fi

# The current value, in the forms a loader accepts: optional export, quotes, trailing comment.
current=$(awk -F= '{ name = $1; sub(/^[ \t]*export[ \t]+/, "", name); sub(/[ \t\r]+$/, "", name) }
	name == "ENCRYPTION_KEY" { value = substr($0, index($0, "=") + 1); sub(/[ \t]+#.*/, "", value);
	gsub(/^[ \t\r]+|[ \t\r]+$/, "", value); gsub(/^["'"'"']+|["'"'"']+$/, "", value); found = value }
	END { print found }' "$ENV_FILE")

if [ -z "$current" ]; then
	echo "rotate-encryption-key: ENCRYPTION_KEY is not set in $ENV_FILE, so there is nothing to rotate. Run make prod-lite to generate one." >&2
	exit 1
fi

if [ -f "$PENDING" ]; then
	new=$(tr -d ' \t\r\n' <"$PENDING")
else
	new=$(openssl rand -hex 32)
	printf '%s\n' "$new" >"$PENDING"
fi

if [ "$new" = "$current" ]; then
	rm -f "$PENDING"
	echo "rotate-encryption-key: $ENV_FILE already has the new key; nothing left to do."
	exit 0
fi

# Stop what reads the key while it changes. Failure here (nothing running) is fine.
$COMPOSE stop web worker agent detector billing >/dev/null 2>&1 || true

# The keys travel in this process's environment, never on a command line.
OLD_ENCRYPTION_KEY="$current" NEW_ENCRYPTION_KEY="$new" \
	$COMPOSE --profile rotate run --rm --build rotate-encryption-key

tmpdir=$(mktemp -d "./.env.tmp.XXXXXX")
TRACEROOT_NEW_KEY="$new" awk -F= 'BEGIN { OFS = "=" } { name = $1; sub(/^[ \t]*export[ \t]+/, "", name); sub(/[ \t\r]+$/, "", name) }
	name == "ENCRYPTION_KEY" { print name, ENVIRON["TRACEROOT_NEW_KEY"]; found = 1; next } { print }
	END { if (!found) print "ENCRYPTION_KEY", ENVIRON["TRACEROOT_NEW_KEY"] }' "$ENV_FILE" >"$tmpdir/env" || { rm -rf "$tmpdir"; exit 1; }
if [ -L "$ENV_FILE" ]; then
	rm -rf "$tmpdir"
	echo "rotate-encryption-key: $ENV_FILE became a symlink during the run. Refusing to write through it." >&2
	exit 1
fi
printf '%s\n' "$current" >"$BACKUP"
mv "$tmpdir/env" "$ENV_FILE"
rmdir "$tmpdir"
rm -f "$PENDING"
echo "rotate-encryption-key: done. $ENV_FILE has the new key; the previous one is in $BACKUP (delete it once you no longer need it). Start the stack with make prod-lite."
