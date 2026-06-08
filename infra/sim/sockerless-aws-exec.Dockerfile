# SPDX-License-Identifier: AGPL-3.0-or-later
# Container-mode sockerless AWS sim image for ecs-dev-desktop e2e.
# PR #519's overlapping-CIDR awsvpc fabric needs Linux netns tools in the sim
# container; the upstream generic image stays minimal for API-only use.

FROM golang:1.25-alpine AS builder
WORKDIR /src
COPY . .
WORKDIR /src/aws
RUN CGO_ENABLED=0 go build -tags noui -ldflags="-s -w" -o /simulator-aws .

FROM alpine:3.20
RUN apk add --no-cache iproute2 nftables procps util-linux wget
COPY --from=builder /simulator-aws /usr/local/bin/simulator-aws
ENTRYPOINT ["simulator-aws"]
