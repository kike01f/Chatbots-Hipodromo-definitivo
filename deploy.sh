#!/bin/bash
# ARTURITO AI — Despliegue producción (reglas + índices + Functions Gen2 + hosting)
# Uso: bash deploy.sh
# Auth sin login interactivo:
#   • .secrets/firebase-sa.json
#   • .secrets/firebase.env  (FIREBASE_TOKEN o GOOGLE_APPLICATION_CREDENTIALS)

set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

ENV_FILE="$ROOT/.secrets/firebase.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
elif [ -x "$ROOT/.tools/node-v20.18.1-darwin-arm64/bin/node" ]; then
  NODE_BIN="$ROOT/.tools/node-v20.18.1-darwin-arm64/bin/node"
elif [ -x "$ROOT/.tools/node-v20.18.1-darwin-x64/bin/node" ]; then
  NODE_BIN="$ROOT/.tools/node-v20.18.1-darwin-x64/bin/node"
fi

if [ -z "$NODE_BIN" ]; then
  echo "❌ Instala Node.js: https://nodejs.org"
  exit 1
fi

export PATH="$(dirname "$NODE_BIN"):$PATH"

FB=""
if command -v firebase >/dev/null 2>&1; then
  FB="firebase"
elif [ -x "$ROOT/.tools/fb-cli/node_modules/.bin/firebase" ]; then
  FB="$ROOT/.tools/fb-cli/node_modules/.bin/firebase"
else
  echo "→ Instalando Firebase CLI..."
  mkdir -p "$ROOT/.tools/fb-cli"
  npm init -y --prefix "$ROOT/.tools/fb-cli" >/dev/null 2>&1 || true
  npm install firebase-tools@14.12.0 --prefix "$ROOT/.tools/fb-cli"
  FB="$ROOT/.tools/fb-cli/node_modules/.bin/firebase"
fi

SA_KEY="$ROOT/.secrets/firebase-sa.json"
if [ -z "${GOOGLE_APPLICATION_CREDENTIALS:-}" ] && [ -f "$SA_KEY" ]; then
  export GOOGLE_APPLICATION_CREDENTIALS="$SA_KEY"
elif [ -n "${GOOGLE_APPLICATION_CREDENTIALS:-}" ] && [[ "${GOOGLE_APPLICATION_CREDENTIALS}" != /* ]]; then
  export GOOGLE_APPLICATION_CREDENTIALS="$ROOT/${GOOGLE_APPLICATION_CREDENTIALS#./}"
fi
if [ -n "${GOOGLE_APPLICATION_CREDENTIALS:-}" ] && [ -f "${GOOGLE_APPLICATION_CREDENTIALS}" ]; then
  echo "→ Auth: ${GOOGLE_APPLICATION_CREDENTIALS}"
elif [ -n "${FIREBASE_TOKEN:-}" ]; then
  echo "→ Auth: FIREBASE_TOKEN"
fi

echo "══════════════════════════════════════════════"
echo "  ARTURITO AI — Deploy producción"
echo "  Firestore: artutitohipodromo02"
echo "══════════════════════════════════════════════"

echo ""
echo "→ [1/4] Dependencias Cloud Functions..."
(cd functions && npm install --omit=dev)

if [ ! -f functions/.env ] && [ -f functions/.env.example ]; then
  echo "   ℹ Copia functions/.env.example → functions/.env con SMTP Gmail"
fi

echo ""
echo "→ [2/4] Reglas Firestore (artutitohipodromo02)..."
echo "→ [3/4] Índices + Storage + Functions Gen2 + Hosting..."

if ! "$FB" deploy \
  --only firestore:rules,firestore:indexes,storage:rules,functions,hosting \
  --project chatbots-hipodromo \
  --non-interactive; then
  echo ""
  echo "❌ Deploy falló (auth). Configura credenciales:"
  echo "   bash setup-firebase-sa.sh   (cuenta de servicio, recomendado)"
  echo "   o .secrets/firebase.env con FIREBASE_TOKEN=..."
  exit 1
fi

echo ""
echo "══════════════════════════════════════════════"
echo "✅ Deploy completado"
echo ""
echo "Funciones desplegadas:"
echo "  • processMailQueue   → mail/{ticketId} → SMTP"
echo "  • notifyAdminOnTicket → tickets/{id} → mail/"
echo ""
echo "Verifica:"
echo "  1. Crea un ticket de prueba"
echo "  2. Firestore artutitohipodromo02 → mail/TK-…"
echo "  3. Campo delivery.success = true"
echo "  4. Logs → logs/mail/entries/"
echo "══════════════════════════════════════════════"
