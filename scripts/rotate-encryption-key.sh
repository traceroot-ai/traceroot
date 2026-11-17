#!/bin/sh
# Move stored provider keys and Slack tokens to a new encryption key, then write the
# new key to .env. Run through `make rotate-encryption-key` from the repository root.
#
# Only one rotation runs at a time: a lock is held from reading the current key until
# .env has the new one. The new key is kept in a private state directory until then, so
# a run that stopped part-way resumes with the same key. The database change is a single
# transaction, so a failure leaves both the data and .env as they were.
set -eu
umask 077

ROOT=$(pwd -P)
ENV_FILE="$ROOT/.env"
ENV_VALUE="$(cd "$(dirname "$0")" && pwd -P)/env-value.sh"
COMPOSE="${ROTATE_COMPOSE:-docker compose -f docker-compose.prod.yml}"
ENV_SECRETS="${ROTATE_ENV_SECRETS:-${MAKE:-make} --no-print-directory env-secrets-unlocked}"

die() {
	echo "rotate-encryption-key: $1" >&2
	exit 1
}
. "$(cd "$(dirname "$0")" && pwd -P)/key-state.sh"

compose() {
	(cd "$ROOT" && $COMPOSE "$@")
}

if [ -L "$ENV_FILE" ]; then
	die ".env is a symlink. Refusing to write secrets through it -- replace it with a regular file."
fi
[ -f "$ENV_FILE" ] || die "no .env here. Run make prod-lite first."

key_state_open

DB_UPDATED=
FINISHED=
cleanup() {
	status=$?
	if [ -n "$DB_UPDATED" ] && [ -z "$FINISHED" ]; then
		echo "rotate-encryption-key: the database already uses the new key but .env was not updated. The new key is kept in $STATE_NAME/pending; fix the problem and run this command again to finish. Do not delete that file." >&2
	fi
	key_state_unlock
	exit "$status"
}
trap cleanup EXIT
trap 'exit 1' INT TERM HUP
key_state_lock

# Generate whatever else is missing, under the same lock so nothing else rewrites .env meanwhile.
(cd "$ROOT" && TRACEROOT_KEY_LOCK_HELD=1 $ENV_SECRETS) || die "could not prepare .env."

current=$(sh "$ENV_VALUE" get ENCRYPTION_KEY "$ENV_FILE")
[ -n "$current" ] ||
	die "ENCRYPTION_KEY is not set in .env, so there is nothing to rotate. Run make prod-lite to generate one."
case "$current" in
*[!0-9a-fA-F]*) die "ENCRYPTION_KEY in .env is not a 64-character hex key, so it cannot be rotated safely." ;;
esac
[ "${#current}" -eq 64 ] || die "ENCRYPTION_KEY in .env is not a 64-character hex key, so it cannot be rotated safely."

# Docker Compose prefers a value in the environment over .env, whether or not it matches
# .env today. Rewriting .env cannot change what the services use, so stop before the database.
if [ -n "${ENCRYPTION_KEY:-}" ]; then
	die "ENCRYPTION_KEY is set in your environment. Docker Compose uses that value instead of .env, so the services would keep the old key after the rotation. Unset it (and keep the key in .env) and run again."
fi
[ -z "${COMPOSE_ENV_FILES:-}" ] ||
	die "COMPOSE_ENV_FILES is set, so Docker Compose may read the key from a file other than .env, which this command does not update. Unset it and run again."
[ -w "$ENV_FILE" ] && [ -w "$ROOT" ] || die "cannot update .env, so the key was not changed."

if [ -e pending ] || [ -L pending ]; then
	[ -f pending ] && [ ! -L pending ] && private_to_me pending 600 ||
		die "$STATE_NAME/pending must be a regular file owned by you with mode 600. Remove it and run again."
	new=$(tr -d ' \t\r\n' <pending)
	case "$new" in
	*[!0-9a-fA-F]* | "") die "$STATE_NAME/pending does not hold a 64-character hex key. Remove it and run again." ;;
	esac
	[ "${#new}" -eq 64 ] || die "$STATE_NAME/pending does not hold a 64-character hex key. Remove it and run again."
else
	new=$(openssl rand -hex 32)
	(
		set -C
		printf '%s\n' "$new" >pending
	)
fi

if [ "$(printf '%s' "$new" | tr 'A-F' 'a-f')" = "$(printf '%s' "$current" | tr 'A-F' 'a-f')" ]; then
	rm -f pending
	echo "rotate-encryption-key: .env already has the new key; nothing left to do."
	exit 0
fi

# Stop what reads the key while it changes. Stopping a service that is not running
# succeeds, so a failure here means something may still be using the old key: abort.
if ! compose stop web worker agent detector billing >/dev/null 2>&1; then
	die "could not stop web, worker, agent, detector and billing, so the key was not changed. Stop them and run again."
fi

# The keys travel in this process's environment, never on a command line.
OLD_ENCRYPTION_KEY="$current" NEW_ENCRYPTION_KEY="$new" \
	compose --profile rotate run --rm --build rotate-encryption-key
DB_UPDATED=1

tmpdir=$(mktemp -d "$ROOT/.env.tmp.XXXXXX")
ENV_VALUE_NEW="$new" sh "$ENV_VALUE" set ENCRYPTION_KEY "$ENV_FILE" >"$tmpdir/env" || { rm -rf "$tmpdir"; exit 1; }
if [ -L "$ENV_FILE" ]; then
	rm -rf "$tmpdir"
	die ".env became a symlink during the run. Refusing to write through it; the new key is in $STATE_NAME/pending."
fi

# Keep the previous key; never overwrite or follow anything already at the name.
backup="previous-$(date +%Y%m%d%H%M%S)"
(
	set -C
	printf '%s\n' "$current" 2>/dev/null >"$backup" || printf '%s\n' "$current" >"$backup.$$"
) || die "could not save the previous key. The database already uses the new key, which is in $STATE_NAME/pending; do not delete it."
mv "$tmpdir/env" "$ENV_FILE"
rmdir "$tmpdir"
[ "$(sh "$ENV_VALUE" get ENCRYPTION_KEY "$ENV_FILE")" = "$new" ] ||
	die ".env does not hold the new key after the update. The database already uses it; it is in $STATE_NAME/pending. Set ENCRYPTION_KEY in .env to that value."
rm -f pending
FINISHED=1
echo "rotate-encryption-key: done. .env has the new key; the previous one is in $STATE_NAME/$backup (delete it once you no longer need it). Start the stack with make prod-lite."
