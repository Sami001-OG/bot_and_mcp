#!/bin/sh
set -e

if [ -n "${RUN_MIGRATIONS:-}" ] && [ "${RUN_MIGRATIONS}" != "false" ]; then
  echo "[start] applying prisma migrations"
  node packages/database/node_modules/prisma/build/index.js migrate deploy --schema packages/database/prisma/schema.prisma
fi

exec "$@"