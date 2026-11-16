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
STATE_NAME=.env.encryption-key.d
COMPOSE="${ROTATE_COMPOSE:-docker compose -f docker-compose.prod.yml}"
ENV_SECRETS="${ROTATE_ENV_SECRETS:-${MAKE:-make} --no-print-directory env-secrets}"

die() {
	echo "rotate-encryption-key: $1" >&2
	exit 1
}

compose() {
	(cd "$ROOT" && $COMPOSE "$@")
}

# True when $1 is owned by the user running this script and has exactly mode $2.
private_to_me() {
	[ -n "$(find "$1" -maxdepth 0 -user "$(id -u)" -perm "$2" 2>/dev/null)" ]
}

if [ -L "$ENV_FILE" ]; then
	die ".env is a symlink. Refusing to write secrets through it -- replace it with a regular file."
fi
[ -f "$ENV_FILE" ] || die "no .env here. Run make prod-lite first."

# State directory: holds the lock, the pending new key and the previous key. Create it
# private, then work from inside it: every later path is relative to a directory this
# process already holds, so replacing the name afterwards cannot redirect a write. The
# check runs after the cd, so a directory someone else prepared is refused.
if [ -L "$ROOT/$STATE_NAME" ]; then
	die "$STATE_NAME is a symlink. Refusing to use it -- remove it and run again."
fi
[ -e "$ROOT/$STATE_NAME" ] || mkdir -m 700 "$ROOT/$STATE_NAME" 2>/dev/null || true # another run may create it first
cd "$ROOT/$STATE_NAME" 2>/dev/null || die "$STATE_NAME must be a directory. Remove it and run again."
private_to_me . 700 ||
	die "$STATE_NAME must be owned by you with mode 700. Remove it and run again."

# One rotation at a time. mkdir is atomic. A lock left behind by a run that was killed is
# never cleared automatically: two runs could each judge it stale and both take it.
LOCK_HELD=
release_lock() {
	[ -z "$LOCK_HELD" ] || rm -rf lock
}
trap release_lock EXIT
trap 'exit 1' INT TERM HUP
if ! mkdir lock 2>/dev/null; then
	owner=$(cat lock/pid 2>/dev/null || true)
	if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then
		die "another key rotation is running, or one was stopped before it finished (process $owner is no longer running). If none is running, remove $STATE_NAME/lock and run again."
	fi
	die "another key rotation is running${owner:+ (process $owner)}. Wait for it to finish, or remove $STATE_NAME/lock if none is."
fi
LOCK_HELD=1
echo $$ >lock/pid

# Generate whatever else is missing, under the same lock so nothing else rewrites .env meanwhile.
(cd "$ROOT" && TRACEROOT_ROTATION_LOCK_HELD=1 $ENV_SECRETS) || die "could not prepare .env."

current=$(sh "$ENV_VALUE" ENCRYPTION_KEY "$ENV_FILE")
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

tmpdir=$(mktemp -d "$ROOT/.env.tmp.XXXXXX")
TRACEROOT_NEW_KEY="$new" awk -F= 'BEGIN { OFS = "=" } { name = $1; sub(/^[ \t]*export[ \t]+/, "", name); sub(/^[ \t]+/, "", name); sub(/[ \t\r]+$/, "", name) }
	name == "ENCRYPTION_KEY" { print name, ENVIRON["TRACEROOT_NEW_KEY"]; found = 1; next } { print }
	END { if (!found) print "ENCRYPTION_KEY", ENVIRON["TRACEROOT_NEW_KEY"] }' "$ENV_FILE" >"$tmpdir/env" || { rm -rf "$tmpdir"; exit 1; }
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
[ "$(sh "$ENV_VALUE" ENCRYPTION_KEY "$ENV_FILE")" = "$new" ] ||
	die ".env does not hold the new key after the update. The database already uses it; it is in $STATE_NAME/pending. Set ENCRYPTION_KEY in .env to that value."
rm -f pending
echo "rotate-encryption-key: done. .env has the new key; the previous one is in $STATE_NAME/$backup (delete it once you no longer need it). Start the stack with make prod-lite."
