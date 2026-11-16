#!/bin/sh
# Print the value Docker Compose uses for KEY in an env file (default .env): the last
# assignment wins, a leading `export` and indentation are ignored, and surrounding
# quotes and a trailing ` # comment` are dropped. Prints nothing when KEY is not set.
# Used by `make env-secrets` and `make rotate-encryption-key` so both agree on which
# value is in effect.
#
# Usage: env-value.sh KEY [FILE]
set -eu
awk -F= -v k="$1" '
	{ name = $1; sub(/^[ \t]*export[ \t]+/, "", name); sub(/^[ \t]+/, "", name); sub(/[ \t\r]+$/, "", name) }
	name == k {
		value = substr($0, index($0, "=") + 1); sub(/[ \t]+#.*/, "", value)
		gsub(/^[ \t\r]+|[ \t\r]+$/, "", value); gsub(/^["'"'"']+|["'"'"']+$/, "", value)
		found = value
	}
	END { print found }' "${2:-.env}"
