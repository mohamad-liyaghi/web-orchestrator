#!/usr/bin/env bash
# Checks a running Orchestrator container from the outside: TLS, health, MIME types, compression,
# caching and security headers.
#
#   deploy/smoke-test.sh [https-base] [http-base]
#   deploy/smoke-test.sh https://localhost:8443 http://127.0.0.1:8088
#
# Runtime assets (wasm, models, samples) are checked when they are present in the build and
# reported as skipped otherwise. Exit status is the number of failed checks.
set -uo pipefail

HTTPS=${1:-https://localhost:8443}
HTTP=${2:-http://127.0.0.1:8088}
CURL=(curl -sk --max-time 15)
pass=0 fail=0 skip=0

ok() { pass=$((pass + 1)); printf '  \033[32mok\033[0m    %s\n' "$*"; }
ko() { fail=$((fail + 1)); printf '  \033[31mFAIL\033[0m  %s\n' "$*"; }
sk() { skip=$((skip + 1)); printf '  \033[33mskip\033[0m  %s\n' "$*"; }

# headers <url> [curl args...] -> response headers, lower-cased names
headers() { local url=$1; shift; "${CURL[@]}" -o /dev/null -D - "$@" "$url" | tr -d '\r'; }
header() { grep -i "^$2:" <<<"$1" | head -1 | cut -d: -f2- | sed 's/^ //'; }
status() { head -1 <<<"$1" | awk '{print $2}'; }

expect() { # expect <label> <actual> <extended-regex>
	if [[ $2 =~ $3 ]]; then ok "$1: $2"; else ko "$1: got '$2', want /$3/"; fi
}

echo "TLS and health"
h=$(headers "$HTTPS/healthz" --http2)
expect "https /healthz status" "$(status "$h")" '^200$'
expect "https protocol" "$(head -1 <<<"$h" | awk '{print $1}')" '^HTTP/2$'
expect "https /healthz body" "$("${CURL[@]}" "$HTTPS/healthz")" '^ok$'
h=$(headers "$HTTP/healthz")
expect "http /healthz status" "$(status "$h")" '^200$'
cert=$(echo | openssl s_client -connect "$(sed -E 's#^https://##; s#/.*##' <<<"$HTTPS")" -servername localhost 2>/dev/null | openssl x509 -noout -ext subjectAltName 2>/dev/null | tail -1 | sed 's/^ *//')
expect "certificate SAN" "$cert" '(DNS|IP)'

echo "Page and security headers"
h=$(headers "$HTTPS/")
expect "/ status" "$(status "$h")" '^200$'
expect "/ content-type" "$(header "$h" content-type)" '^text/html'
expect "/ cache-control" "$(header "$h" cache-control)" '^no-cache$'
expect "server header hides version" "$(header "$h" server)" '^nginx$'
expect "x-content-type-options" "$(header "$h" x-content-type-options)" '^nosniff$'
expect "x-frame-options" "$(header "$h" x-frame-options)" '^DENY$'
expect "referrer-policy" "$(header "$h" referrer-policy)" '.+'
expect "permissions-policy" "$(header "$h" permissions-policy)" 'camera=\(self\).*microphone=\(\)'
csp="$(header "$h" content-security-policy)$(header "$h" content-security-policy-report-only)"
expect "content-security-policy" "$csp" "wasm-unsafe-eval"
h=$(headers "$HTTP/")
expect "http / security headers" "$(header "$h" permissions-policy)" 'camera=\(self\)'

echo "Routing"
h=$(headers "$HTTPS/play/some-route")
expect "SPA route -> index.html" "$(status "$h") $(header "$h" content-type)" '^200 text/html'
h=$(headers "$HTTPS/assets/missing-file.js")
expect "missing file is a real 404" "$(status "$h")" '^404$'
expect "404 is not cached" "$(header "$h" cache-control)" '^no-store$'
expect "404 keeps security headers" "$(header "$h" x-content-type-options)" '^nosniff$'
expect "dotfiles hidden" "$(status "$(headers "$HTTPS/.env")")" '^404$'
expect "POST rejected" "$(status "$(headers "$HTTPS/" -X POST)")" '^(403|405)$'
expect "TRACE rejected" "$(status "$(headers "$HTTPS/" -X TRACE)")" '^405$'

echo "Hashed bundle"
js=$("${CURL[@]}" "$HTTPS/" | grep -oE 'assets/[^"]+\.js' | head -1)
if [[ -n $js ]]; then
	h=$(headers "$HTTPS/$js" -H 'Accept-Encoding: gzip')
	expect "$js type" "$(header "$h" content-type)" '^(text|application)/javascript'
	expect "$js cache" "$(header "$h" cache-control)" 'max-age=31536000, immutable'
	expect "$js gzip" "$(header "$h" content-encoding)" '^gzip$'
	expect "$js vary" "$(header "$h" vary)" 'Accept-Encoding'
else
	ko "no assets/*.js referenced by index.html"
fi

echo "Runtime assets"
check_asset() { # check_asset <path> <type-regex> <gzip yes|no>
	local h
	h=$(headers "$HTTPS/$1" -H 'Accept-Encoding: gzip')
	if [[ $(status "$h") == 404 ]]; then sk "$1 not in this build"; return; fi
	expect "$1 status" "$(status "$h")" '^200$'
	expect "$1 type" "$(header "$h" content-type)" "$2"
	expect "$1 cache" "$(header "$h" cache-control)" 'max-age=2592000'
	if [[ $3 == yes ]]; then
		expect "$1 gzip" "$(header "$h" content-encoding)" '^gzip$'
	else
		expect "$1 not gzipped" "$(header "$h" content-encoding)" '^$'
	fi
}
check_asset mediapipe/wasm/vision_wasm_internal.wasm '^application/wasm$' yes
check_asset mediapipe/wasm/vision_wasm_internal.js '^(text|application)/javascript' yes
check_asset models/hand_landmarker.task '^application/octet-stream$' no
check_asset models/face_landmarker.task '^application/octet-stream$' no
sample=${SMOKE_SAMPLE:-samples/grand-piano/C4.mp3}
check_asset "$sample" '^audio/mpeg$' no

echo
echo "passed $pass, failed $fail, skipped $skip"
exit "$fail"
