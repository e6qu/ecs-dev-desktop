# SPDX-License-Identifier: AGPL-3.0-or-later
# Builds the sockerless bleephub GitHub server FROM SOURCE (pinned submodule).
# bleephub ships only an integration-test Dockerfile (sockerless #384 aside), so we
# build the plain server from `bleephub/cmd` with `-tags noui` (skips the UI embed).
FROM golang:1.25-alpine AS builder
WORKDIR /src
COPY third_party/sockerless/bleephub/ ./
RUN GOWORK=off CGO_ENABLED=0 go build -tags noui -o /bleephub ./cmd

FROM alpine:3.20
RUN apk add --no-cache wget
COPY --from=builder /bleephub /usr/local/bin/bleephub
EXPOSE 5555
ENTRYPOINT ["bleephub", "-addr", ":5555"]
