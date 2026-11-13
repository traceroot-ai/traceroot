#!/bin/sh
# Move stored provider keys and Slack tokens to a new encryption key, then write the
# new key to .env. Run through `make rotate-encryption-key` from the repository root.
#
# Safe to repeat: the new key is kept in a private state directory until .env has it, so
# a run that stopped part-way resumes with the same key. The database change is a single
# transaction, so a failure leaves both the data and .env as they were.
set -eu
umask 077

ENV_FILE=.env
STATE_DIR=.env.encryption-key.d
PENDING="$STATE_DIR/pending"
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

die() {
	echo "rotate-encryption-key: $1" >&2
	exit 1
}

if [ -z "$current" ]; then
	die "ENCRYPTION_KEY is not set in $ENV_FILE, so there is nothing to rotate. Run make prod-lite to generate one."
fi

# True when $1 is owned by the user running this script and has exactly mode $2.
private_to_me() {
	[ -n "$(find "$1" -maxdepth 0 -user "$(id -u)" -perm "$2" 2>/dev/null)" ]
}

# The state directory holds the new key and the previous one. Create it private, and
# refuse one that is a link, someone else's, or readable by others: whoever can write
# there could choose the new key or read the old one.
if [ -L "$STATE_DIR" ]; then
	die "$STATE_DIR is a symlink. Refusing to use it -- remove it and run again."
elif [ -e "$STATE_DIR" ]; then
	[ -d "$STATE_DIR" ] && private_to_me "$STATE_DIR" 700 ||
		die "$STATE_DIR must be a directory owned by you with mode 700. Remove it and run again."
else
	mkdir -m 700 "$STATE_DIR"
fi
if [ -e "$PENDING" ] || [ -L "$PENDING" ]; then
	[ -f "$PENDING" ] && [ ! -L "$PENDING" ] && private_to_me "$PENDING" 600 ||
		die "$PENDING must be a regular file owned by you with mode 600. Remove it and run again."
fi

if [ -f "$PENDING" ]; then
	new=$(tr -d ' \t\r\n' <"$PENDING")
	case "$new" in
	*[!0-9a-fA-F]* | "") die "$PENDING does not hold a 64-character hex key. Remove it and run again." ;;
	esac
	[ "${#new}" -eq 64 ] || die "$PENDING does not hold a 64-character hex key. Remove it and run again."
else
	new=$(openssl rand -hex 32)
	printf '%s\n' "$new" >"$PENDING"
fi

if [ "$new" = "$current" ]; then
	rm -f "$PENDING"
	echo "rotate-encryption-key: $ENV_FILE already has the new key; nothing left to do."
	exit 0
fi

# Stop what reads the key while it changes. Stopping a service that is not running
# succeeds, so a failure here means something may still be using the old key: abort.
if ! $COMPOSE stop web worker agent detector billing >/dev/null 2>&1; then
	die "could not stop web, worker, agent, detector and billing, so the key was not changed. Stop them and run again."
fi

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
backup="$STATE_DIR/previous-$(date +%Y%m%d%H%M%S)"
printf '%s\n' "$current" >"$backup"
mv "$tmpdir/env" "$ENV_FILE"
rmdir "$tmpdir"
rm -f "$PENDING"
echo "rotate-encryption-key: done. $ENV_FILE has the new key; the previous one is in $backup (delete it once you no longer need it). Start the stack with make prod-lite."
