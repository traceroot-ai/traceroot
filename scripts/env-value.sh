#!/bin/sh
# Read or replace one assignment in an env file the way Docker Compose does, so that
# `make env-secrets`, `make rotate-encryption-key` and the launcher agree on which value
# is in effect. An assignment is `NAME=value` or `NAME: value`, with optional indentation,
# a leading `export`, and spaces around the separator; the last one wins. Surrounding
# quotes and a trailing ` # comment` are dropped from a value.
#
# Usage:
#   env-value.sh KEY [FILE]                print the value in effect (nothing if unset)
#   env-value.sh --set KEY FILE            print FILE with every KEY assignment replaced by
#                                          KEY=$ENV_VALUE_NEW, or with it appended if absent
set -eu

PARSE='
function split_assignment(line,   rest) {
	rest = line
	sub(/^[ \t]*export[ \t]+/, "", rest); sub(/^[ \t]+/, "", rest)
	if (!match(rest, /^[A-Za-z_][A-Za-z0-9_.-]*[ \t]*[=:]/)) return 0
	a_name = substr(rest, 1, RLENGTH - 1); sub(/[ \t]+$/, "", a_name)
	a_value = substr(rest, RLENGTH + 1)
	return 1
}'

if [ "$1" = "--set" ]; then
	ENV_VALUE_KEY="$2" awk "$PARSE"'
		BEGIN { k = ENVIRON["ENV_VALUE_KEY"]; v = ENVIRON["ENV_VALUE_NEW"] }
		split_assignment($0) && a_name == k { print k "=" v; found = 1; next }
		{ print }
		END { if (!found) print k "=" v }' "$3"
	exit 0
fi

awk -v k="$1" "$PARSE"'
	split_assignment($0) && a_name == k {
		value = a_value; sub(/[ \t]+#.*/, "", value)
		gsub(/^[ \t\r]+|[ \t\r]+$/, "", value); gsub(/^["'"'"']+|["'"'"']+$/, "", value)
		found = value
	}
	END { print found }' "${2:-.env}"
