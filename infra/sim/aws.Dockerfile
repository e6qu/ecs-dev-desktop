# SPDX-License-Identifier: AGPL-3.0-or-later
# Builds the sockerless AWS simulator FROM SOURCE (pinned third_party/sockerless
# submodule). Build context is the repo root so the whole simulators/ tree is
# present — each sim module replaces ../realexec, so the upstream per-cloud
# context (simulators/aws) can't build (sockerless #366).
FROM golang:1.25-alpine AS builder
WORKDIR /src
COPY third_party/sockerless/simulators/ ./
WORKDIR /src/aws
RUN CGO_ENABLED=0 go build -tags noui -ldflags="-s -w" -o /simulator-aws .

FROM alpine:3.20
RUN apk add --no-cache wget
COPY --from=builder /simulator-aws /usr/local/bin/simulator-aws
EXPOSE 4566
ENTRYPOINT ["simulator-aws"]
