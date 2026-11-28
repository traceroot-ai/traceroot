#!/bin/sh
# Run a command while holding the encryption key lock, so it cannot overlap a key rotation.
# Starting services or rewriting .env through this keeps them from running with a key the
# database is being moved away from. It also refuses while a rotation has not finished.
#
# Usage (from the repository root): with-key-lock.sh COMMAND [ARGS...]
set -eu
umask 077

ROOT=$(pwd -P)
die() {
	echo "$1" >&2
	exit 1
}
. "$(cd "$(dirname "$0")" && pwd -P)/key-state.sh"

refuse_other_env_files

# A command run by another one that already holds the lock (the rotation, or make calling
# make) must not wait for itself.
if [ -n "${TRACEROOT_KEY_LOCK_HELD:-}" ]; then
	exec "$@"
fi

key_state_open
trap 'key_state_unlock' EXIT
trap 'exit 1' INT TERM HUP
key_state_lock
if [ -e pending ]; then
	die "A key rotation did not finish. Run make rotate-encryption-key again to finish it (or remove $STATE_NAME/pending to abandon it) before starting."
fi

# Not exec: this shell stays to release the lock afterwards.
status=0
(cd "$ROOT" && TRACEROOT_KEY_LOCK_HELD=1 "$@") || status=$?
exit "$status"
