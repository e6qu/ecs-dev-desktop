# SPDX-License-Identifier: AGPL-3.0-or-later
# Local image build: terraform invokes the repo's publish-images.sh during apply.
# The operator/CI machine must have docker (or podman aliased as docker) and the
# repo source checked out at local_build_context_path. The task definitions
# depend_on this resource so they are created only after the images exist.

resource "terraform_data" "build_images_local" {
  count = local.build_local_enabled ? 1 : 0

  triggers_replace = [
    var.image_tag,
    join(",", var.golden_image_repos),
  ]

  provisioner "local-exec" {
    command     = "sh ${path.module}/scripts/build-images-local.sh ${local.account_id} ${local.region} ${var.name} ${var.image_tag} ${join(" ", var.golden_image_repos)}"
    working_dir = var.local_build_context_path
  }

  depends_on = [
    aws_ecr_repository.control_plane,
    aws_ecr_repository.golden,
    aws_ecr_repository.ssh_gateway,
  ]
}
