#!/bin/sh
# Picks the TLS certificate, then hands over to nginx.
#
#   1. A real certificate mounted at /etc/nginx/certs/custom/{fullchain,privkey}.pem is used as-is.
#   2. Otherwise a self-signed certificate is kept in /etc/nginx/certs/self-signed (a volume). It is
#      created on first start and re-created when PUBLIC_HOST changes or it is about to expire.
#
# Environment:
#   PUBLIC_HOST   comma-separated IPs and/or hostnames the self-signed certificate is valid for
#                 (localhost, 127.0.0.1 and ::1 are always included). Default: localhost.
#   TLS_DAYS      validity of the self-signed certificate in days (default 397, the browser maximum).
set -eu

CUSTOM_DIR=/etc/nginx/certs/custom
SELF_DIR=/etc/nginx/certs/self-signed
LINK_DIR=/tmp/tls
PUBLIC_HOST=${PUBLIC_HOST:-localhost}
TLS_DAYS=${TLS_DAYS:-397}

log() { echo "[entrypoint] $*" >&2; }
fail() { log "ERROR: $*"; exit 1; }

is_ip() {
	case "$1" in
		*:*) return 0 ;; # IPv6
		*[!0-9.]*) return 1 ;;
		*.*.*.*) return 0 ;;
		*) return 1 ;;
	esac
}

# subjectAltName list for PUBLIC_HOST + loopback, de-duplicated, in a stable order.
san_list() {
	echo "$PUBLIC_HOST,localhost,127.0.0.1,::1" | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' |
		awk 'NF && !seen[$0]++' | while read -r host; do
			if is_ip "$host"; then echo "IP:$host"; else echo "DNS:$host"; fi
		done | paste -sd, -
}

validate_hosts() {
	old_ifs=$IFS
	IFS=,
	for host in $PUBLIC_HOST; do
		host=$(echo "$host" | tr -d '[:space:]')
		case "$host" in
			*[!A-Za-z0-9.:-]*) fail "invalid host in PUBLIC_HOST: '$host'" ;;
		esac
	done
	IFS=$old_ifs
}

generate_self_signed() {
	san=$1
	cn=$(echo "$PUBLIC_HOST" | cut -d, -f1 | tr -d '[:space:]')
	mkdir -p "$SELF_DIR"
	umask 077
	tmp=$(mktemp -d /tmp/tls-gen.XXXXXX)
	openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -sha256 \
		-days "$TLS_DAYS" -subj "/CN=${cn:-localhost}/O=Orchestrator self-signed" \
		-addext "subjectAltName=$san" \
		-addext "basicConstraints=critical,CA:FALSE" \
		-addext "keyUsage=critical,digitalSignature" \
		-addext "extendedKeyUsage=serverAuth" \
		-keyout "$tmp/key.pem" -out "$tmp/cert.pem" 2>/dev/null ||
		fail "openssl could not create the self-signed certificate"
	mv "$tmp/key.pem" "$SELF_DIR/privkey.pem"
	mv "$tmp/cert.pem" "$SELF_DIR/fullchain.pem"
	echo "$san" >"$SELF_DIR/san.txt"
	rmdir "$tmp"
	umask 022
	log "created a self-signed certificate for $san (valid $TLS_DAYS days)"
}

select_certificate() {
	if [ -e "$CUSTOM_DIR/fullchain.pem" ] || [ -e "$CUSTOM_DIR/privkey.pem" ]; then
		cert=$CUSTOM_DIR/fullchain.pem
		key=$CUSTOM_DIR/privkey.pem
		[ -r "$cert" ] || fail "$cert is missing or unreadable"
		[ -r "$key" ] || fail "$key is missing or not readable by uid $(id -u) (chmod 0640 and chgrp $(id -g), or copy it with readable permissions)"
		openssl x509 -in "$cert" -noout 2>/dev/null || fail "$cert is not a PEM certificate"
		if ! openssl x509 -in "$cert" -noout -checkend 0 >/dev/null 2>&1; then
			log "WARNING: the mounted certificate has expired"
		fi
		log "using the mounted certificate: $(openssl x509 -in "$cert" -noout -subject 2>/dev/null)"
	else
		[ -w "$SELF_DIR" ] || fail "$SELF_DIR is not writable; mount a volume there"
		cert=$SELF_DIR/fullchain.pem
		key=$SELF_DIR/privkey.pem
		validate_hosts
		san=$(san_list)
		if [ ! -s "$cert" ] || [ ! -s "$key" ]; then
			generate_self_signed "$san"
		elif [ "$(cat "$SELF_DIR/san.txt" 2>/dev/null)" != "$san" ]; then
			log "PUBLIC_HOST changed, renewing the self-signed certificate"
			generate_self_signed "$san"
		elif ! openssl x509 -in "$cert" -noout -checkend 2592000 >/dev/null 2>&1; then
			log "the self-signed certificate expires within 30 days, renewing it"
			generate_self_signed "$san"
		else
			log "using the self-signed certificate for $san"
		fi
	fi

	mkdir -p "$LINK_DIR"
	ln -sf "$cert" "$LINK_DIR/cert.pem"
	ln -sf "$key" "$LINK_DIR/key.pem"
}

select_certificate
exec "$@"
