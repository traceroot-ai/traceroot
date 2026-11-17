# Sourced by scripts/rotate-encryption-key.sh and scripts/with-key-lock.sh.
#
# The encryption key's state directory (.env.encryption-key.d) holds the lock, the pending
# new key and the previous key. Anything that starts services or rewrites .env takes the
# lock, as does a rotation, so the two never overlap: services never run with a key the
# database is being moved away from.
#
# Expects: ROOT (the checkout), and a die() function.

STATE_NAME=.env.encryption-key.d
LOCK_HELD=

# True when $1 is owned by the user running this script and has exactly mode $2.
private_to_me() {
	[ -n "$(find "$1" -maxdepth 0 -user "$(id -u)" -perm "$2" 2>/dev/null)" ]
}

# Create the directory private, then work from inside it: every later path is relative to
# a directory this process already holds, so replacing the name afterwards cannot redirect
# a write. The ownership check runs after the cd, so a directory someone else prepared is
# refused.
key_state_open() {
	if [ -L "$ROOT/$STATE_NAME" ]; then
		die "$STATE_NAME is a symlink. Refusing to use it -- remove it and run again."
	fi
	[ -e "$ROOT/$STATE_NAME" ] || mkdir -m 700 "$ROOT/$STATE_NAME" 2>/dev/null || true # a parallel run may create it first
	cd "$ROOT/$STATE_NAME" 2>/dev/null || die "$STATE_NAME must be a directory. Remove it and run again."
	private_to_me . 700 ||
		die "$STATE_NAME must be owned by you with mode 700. Remove it and run again."
}

# One at a time. mkdir is atomic. A lock left behind by a run that was killed is never
# cleared automatically: two runs could each judge it stale and both take it.
key_state_lock() {
	if ! mkdir lock 2>/dev/null; then
		owner=$(cat lock/pid 2>/dev/null || true)
		if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then
			die "another start or key rotation is running, or one was stopped before it finished (process $owner is no longer running). If none is running, remove $STATE_NAME/lock and run again."
		fi
		die "another start or key rotation is running${owner:+ (process $owner)}. Wait for it to finish, or remove $STATE_NAME/lock if none is."
	fi
	LOCK_HELD=1
	echo $$ >lock/pid
}

key_state_unlock() {
	[ -z "$LOCK_HELD" ] || rm -rf lock
	LOCK_HELD=
}
