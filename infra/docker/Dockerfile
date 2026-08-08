FROM node:22.22.0-alpine AS build
RUN corepack enable
WORKDIR /app
ARG NEXT_PUBLIC_API_URL=http://localhost:4000/api/v1
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build
FROM node:22.22.0-alpine AS runtime
RUN addgroup -S platform && adduser -S platform -G platform
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=platform:platform /app /app
USER platform
CMD ["node", "apps/api/dist/main.js"]
