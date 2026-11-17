#!/bin/sh
# Read or change one value in an env file using Docker Compose itself, so `make env-secrets`,
# `make rotate-encryption-key` and the launcher always agree with what the services get
# (quoting, multi-line values, `NAME: value`, repeated assignments, `export`, and so on).
# The docker CLI is enough; no daemon is needed to read a value.
#
# Usage:
#   env-value.sh get KEY [FILE]      print the value Compose resolves for KEY (empty if unset)
#   env-value.sh set KEY FILE        print FILE with KEY set to $ENV_VALUE_NEW: the last
#                                    matching line is replaced when that changes what Compose
#                                    resolves, otherwise a new last assignment is appended
set -eu

# Undo the JSON string escapes Compose applies (\n, \t, \", \\, and \u00XX for characters such
# as & that it escapes); other characters, including non-ASCII ones, arrive unescaped.
unescape_json() {
	awk '
		function hex(h,   i, n, c) {
			n = 0
			for (i = 1; i <= length(h); i++) { c = index("0123456789abcdef", tolower(substr(h, i, 1))); n = n * 16 + c - 1 }
			return n
		}
		{
			out = ""; i = 1
			while (i <= length($0)) {
				c = substr($0, i, 1)
				if (c != "\\") { out = out c; i++; continue }
				e = substr($0, i + 1, 1)
				if (e == "u") { out = out sprintf("%c", hex(substr($0, i + 2, 4))); i += 6; continue }
				out = out (e == "n" ? "\n" : e == "t" ? "\t" : e == "r" ? "\r" : e == "b" ? "\b" : e == "f" ? "\f" : e)
				i += 2
			}
			printf "%s", out
		}'
}

resolve() { # resolve KEY FILE
	probe=$(mktemp -d)
	printf 'services:\n  v:\n    image: x\n    environment:\n      V: "${%s:-}"\n' "$1" >"$probe/compose.yml"
	status=0
	value=$(docker compose --env-file "$2" -f "$probe/compose.yml" --project-directory "$probe" config --format json 2>/dev/null |
		sed -n -e 's/^ *"V": "//' -e 'T' -e 's/",\{0,1\}$//' -e 'p' | unescape_json) || status=$?
	rm -rf "$probe"
	[ "$status" -eq 0 ] || {
		echo "env-value: could not read $2 with docker compose" >&2
		return 1
	}
	printf '%s' "$value"
}

command=$1
key=$2
file=${3:-.env}

case "$command" in
get)
	resolve "$key" "$file"
	;;
set)
	new=${ENV_VALUE_NEW:?ENV_VALUE_NEW is not set}
	work=$(mktemp -d)
	trap 'rm -rf "$work"' EXIT
	ENV_VALUE_KEY="$key" awk '
		BEGIN { k = ENVIRON["ENV_VALUE_KEY"]; v = ENVIRON["ENV_VALUE_NEW"] }
		{
			line[NR] = $0
			rest = $0; sub(/^[ \t]*export[ \t]+/, "", rest); sub(/^[ \t]+/, "", rest)
			if (match(rest, /^[A-Za-z_][A-Za-z0-9_.-]*[ \t]*[=:]/)) {
				name = substr(rest, 1, RLENGTH - 1); sub(/[ \t]+$/, "", name)
				if (name == k) last = NR
			}
		}
		END { for (i = 1; i <= NR; i++) print (i == last ? k "=" v : line[i]) }' "$file" >"$work/in-place"
	if [ "$(resolve "$key" "$work/in-place")" = "$new" ]; then
		cat "$work/in-place"
		exit 0
	fi
	# The matching line was not the assignment Compose uses (for example it sits inside a
	# multi-line value), so leave every existing line alone and add a later assignment.
	cp "$file" "$work/appended"
	[ -z "$(tail -c1 "$work/appended")" ] || printf '\n' >>"$work/appended"
	printf '%s=%s\n' "$key" "$new" >>"$work/appended"
	[ "$(resolve "$key" "$work/appended")" = "$new" ] || {
		echo "env-value: could not set $key in a way Docker Compose reads back" >&2
		exit 1
	}
	cat "$work/appended"
	;;
*)
	echo "usage: env-value.sh get KEY [FILE] | set KEY FILE" >&2
	exit 2
	;;
esac
