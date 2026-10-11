// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Public images the e2e tests run as ECS tasks. Each one is the Amazon ECR Public
// copy of a Docker official image, because Docker Hub limits anonymous pulls per
// address and the shared CI runners exhaust that limit. Each is pinned by tag and
// by the index digest Docker Hub serves for the tag; scripts/check-image-pins.mjs
// reports when Docker Hub moves the tag.

/** A long-running default command (nginx), so a launched task stays RUNNING. */
export const NGINX_ALPINE =
  "public.ecr.aws/docker/library/nginx:alpine@sha256:df221db836e1754089190208cee7eeda94f233197056426eda74a43ab1abeac2";

/** A small image with `sh` and `httpd`, for tasks that run their own command. */
export const BUSYBOX =
  "public.ecr.aws/docker/library/busybox:latest@sha256:fd7dc98638c8e305f4dc34e979f1c0fdfdcaeb0fbf8fcff77ae834b6da3d7e6e";

/** A small image with a shell and a package-free userland. */
export const ALPINE =
  "public.ecr.aws/docker/library/alpine:latest@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6";
