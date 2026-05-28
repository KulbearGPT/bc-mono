FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json tsconfig.build.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/bot/package.json apps/bot/package.json
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY modules/platform/package.json modules/platform/package.json
COPY database/package.json database/package.json
RUN npm ci
COPY apps apps
COPY modules modules
COPY database database
RUN npm run build:railway

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
RUN npm prune --omit=dev
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/bot/package.json ./apps/bot/package.json
COPY --from=build /app/apps/bot/dist ./apps/bot/dist
COPY --from=build /app/apps/dashboard/dist ./apps/dashboard/dist
COPY --from=build /app/apps/dashboard/package.json ./apps/dashboard/package.json
COPY --from=build /app/modules/platform/package.json ./modules/platform/package.json
COPY --from=build /app/modules/platform/dist ./modules/platform/dist
COPY --from=build /app/database/package.json ./database/package.json
COPY --from=build /app/database/prisma ./database/prisma
CMD ["npm", "run", "start:web"]
