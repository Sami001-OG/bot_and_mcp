#!/bin/sh
set -e

if [ "$1" = "web" ]; then
  cd apps/web
  exec node ../../node_modules/next/dist/bin/next start -p "${PORT:-3000}"
fi

if [ -n "${RUN_MIGRATIONS:-}" ] && [ "${RUN_MIGRATIONS}" != "false" ]; then
  echo "[start] applying prisma migrations"
  node packages/database/node_modules/prisma/build/index.js migrate deploy --schema packages/database/prisma/schema.prisma
fi

exec "$@"