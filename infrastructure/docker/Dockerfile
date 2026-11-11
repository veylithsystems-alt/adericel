# Adericel API and worker.
#
# One image runs the API, the worker and the migration job — they share the same
# code and the same dependency tree, so building them separately would mean
# three chances for the versions to diverge.
#
# Build from the repository root:
#   docker build -f infrastructure/docker/Dockerfile -t adericel/app .

# ---------------------------------------------------------------------- base
FROM node:22.22-alpine AS base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# Manifests only, so a source-only change does not invalidate the install layer.
# Every workspace package is listed explicitly: a glob would silently stop
# copying a new package and the failure would appear as a confusing resolution
# error much later in the build.
FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json        packages/shared/
COPY packages/domain/package.json        packages/domain/
COPY packages/graph/package.json         packages/graph/
COPY packages/evidence/package.json      packages/evidence/
COPY packages/truth-engine/package.json  packages/truth-engine/
COPY packages/policy/package.json        packages/policy/
COPY packages/autonomy/package.json      packages/autonomy/
COPY packages/value/package.json         packages/value/
COPY packages/triage/package.json        packages/triage/
COPY packages/questionnaire/package.json packages/questionnaire/
COPY packages/inference/package.json packages/inference/
COPY packages/containment/package.json packages/containment/
COPY packages/support/package.json packages/support/
COPY packages/actions/package.json       packages/actions/
COPY packages/integrations/package.json  packages/integrations/
COPY packages/billing/package.json       packages/billing/
COPY packages/notifications/package.json packages/notifications/
COPY apps/api/package.json               apps/api/
COPY apps/worker/package.json            apps/worker/
COPY apps/web/package.json               apps/web/

# --------------------------------------------------------------------- build
FROM manifests AS build

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY tsconfig.base.json tsconfig.build.json tsconfig.json ./
COPY packages/ packages/
COPY apps/api/ apps/api/
COPY apps/worker/ apps/worker/

# `tsc -b` walks the project references, so this builds every package in
# dependency order and fails the build if any of them does not compile.
RUN pnpm build

# ------------------------------------------------------------------- runtime
FROM base AS runtime

ENV NODE_ENV=production

# Production dependencies only. The build toolchain — TypeScript, vitest,
# eslint — has no business in an image that faces the network.
COPY --from=manifests /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/.npmrc ./
COPY --from=manifests /app/packages/ packages/
COPY --from=manifests /app/apps/ apps/
# `--filter` keeps the web application's dependency tree out of a server image.
# React has no business in the SBOM of a process that faces the network.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --ignore-scripts \
      --filter adericel --filter @adericel/api... --filter @adericel/worker...

# Compiled output, copied over the manifest-only skeleton that pnpm has already
# symlinked into place.
COPY --from=build /app/packages/shared/dist        packages/shared/dist/
COPY --from=build /app/packages/domain/dist        packages/domain/dist/
COPY --from=build /app/packages/graph/dist         packages/graph/dist/
COPY --from=build /app/packages/evidence/dist      packages/evidence/dist/
COPY --from=build /app/packages/truth-engine/dist  packages/truth-engine/dist/
COPY --from=build /app/packages/policy/dist        packages/policy/dist/
COPY --from=build /app/packages/autonomy/dist      packages/autonomy/dist/
COPY --from=build /app/packages/value/dist         packages/value/dist/
COPY --from=build /app/packages/triage/dist        packages/triage/dist/
COPY --from=build /app/packages/questionnaire/dist packages/questionnaire/dist/
COPY --from=build /app/packages/inference/dist packages/inference/dist/
COPY --from=build /app/packages/containment/dist packages/containment/dist/
COPY --from=build /app/packages/support/dist packages/support/dist/
COPY --from=build /app/packages/actions/dist       packages/actions/dist/
COPY --from=build /app/packages/integrations/dist  packages/integrations/dist/
COPY --from=build /app/packages/billing/dist       packages/billing/dist/
COPY --from=build /app/packages/notifications/dist packages/notifications/dist/
COPY --from=build /app/apps/api/dist               apps/api/dist/
COPY --from=build /app/apps/worker/dist            apps/worker/dist/

# The migration runner and the SQL it applies. Migrations ship with the image so
# the schema can never be newer or older than the code that reads it.
COPY database/ database/
COPY scripts/migrate.ts scripts/

USER node
EXPOSE 4000

# Overridden per service in docker-compose.yml. The API is the default because
# it is the one an operator running the image by hand almost always wants.
CMD ["node", "apps/api/dist/main.js"]

# ------------------------------------------------------------------- product
# Adericel as a customer receives it.
#
# `runtime` above is already this: it copies no company manifest and no company
# compiled output, because the product's own app names neither.
#
# This target used to delete things — `rm -rf packages/vaol/dist` and the
# compiled company route module — because the product's app declared the company
# layer and reached it through a guarded dynamic import. The deletion made the
# guard fail loudly rather than silently, which was right for that design, and
# it meant the separation was maintained by a removal step. Forgetting the step
# shipped Veylith's autonomy gate, exception queue and business ledger to a
# customer.
#
# The composition is now inverted, so there is nothing to remove. This target
# remains so the documented build command keeps working and an operator can say
# which image they built.
#
# Build with:
#   docker build -f infrastructure/docker/Dockerfile --target product -t adericel/product .
FROM runtime AS product
ENV ADERICEL_COMPANY_LAYER=false
CMD ["node", "apps/api/dist/main.js"]

# ------------------------------------------------------------------- company
# Veylith's own deployment: the product, plus the company layer composed on top.
#
# A separate target rather than a flag on the product image. The product image
# has no company code in it to switch on, which is the point — a configuration
# mistake on a customer's instance cannot produce Veylith's control room,
# because the bytes are not there.
#
# Note the direction: this adds to the product. Nothing is removed from the
# product image to make it, so there is no removal step to forget.
#
# Build with:
#   docker build -f infrastructure/docker/Dockerfile --target company -t veylith/adericel .
FROM runtime AS company
USER root
COPY packages/vaol/package.json packages/vaol/
COPY apps/veylith/package.json apps/veylith/
COPY --from=build /app/packages/vaol/dist   packages/vaol/dist/
COPY --from=build /app/apps/veylith/dist    apps/veylith/dist/
USER node
ENV ADERICEL_COMPANY_LAYER=true
CMD ["node", "apps/veylith/dist/main.js"]
