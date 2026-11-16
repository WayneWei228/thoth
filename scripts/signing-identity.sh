#!/bin/bash
# The local code-signing identity for Thoth.app (macos/build-app.sh signs with it).
# Why: an ad-hoc signature changes with every build, so macOS (TCC) drops the Accessibility and
# Screen Recording grants after each rebuild. A signature from one fixed certificate gives the same
# designated requirement on every build, and the grants stay.
#   scripts/signing-identity.sh          create the identity once (does nothing when it exists)
#   scripts/signing-identity.sh --check  exit 0 when the identity exists, 1 when not; changes nothing
# The certificate is self-signed and stays in the login keychain of this Mac. It is not trusted
# by anyone else and is not used for distribution.
set -euo pipefail
NAME="${THOTH_SIGN_IDENTITY:-Thoth Local Signing}"
KEYCHAIN="${THOTH_SIGN_KEYCHAIN:-$HOME/Library/Keychains/login.keychain-db}"

has_identity() { security find-identity -p codesigning "$KEYCHAIN" 2>/dev/null | grep -qF "\"$NAME\""; }

if [ "${1:-}" = "--check" ]; then has_identity; exit; fi
if has_identity; then echo "signing-identity: \"$NAME\" exists"; exit 0; fi

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/cert.cnf" <<CNF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $NAME
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
subjectKeyIdentifier = hash
CNF
# /usr/bin/openssl (LibreSSL) writes a PKCS#12 file that `security import` can read;
# OpenSSL 3 needs -legacy for that.
OPENSSL=/usr/bin/openssl
"$OPENSSL" req -x509 -newkey rsa:2048 -nodes -days 3650 -sha256 \
  -config "$TMP/cert.cnf" -keyout "$TMP/key.pem" -out "$TMP/cert.pem" 2>/dev/null
PASS="thoth-$$-$RANDOM"
"$OPENSSL" pkcs12 -export -inkey "$TMP/key.pem" -in "$TMP/cert.pem" -name "$NAME" \
  -out "$TMP/id.p12" -passout "pass:$PASS"
# -T: codesign may use the private key without asking
security import "$TMP/id.p12" -k "$KEYCHAIN" -P "$PASS" -T /usr/bin/codesign >/dev/null
if has_identity; then
  echo "signing-identity: created \"$NAME\" in $KEYCHAIN"
else
  echo "signing-identity: imported, but \"$NAME\" is not a code-signing identity" >&2; exit 1
fi
