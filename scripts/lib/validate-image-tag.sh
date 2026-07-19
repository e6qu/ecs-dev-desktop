# SPDX-License-Identifier: AGPL-3.0-or-later
# shellcheck shell=sh

validate_image_tag() { # <tag> [display name]
  image_tag_value="${1:-}"
  image_tag_name="${2:-image tag}"

  case "$image_tag_value" in
    '' | *[!0-9a-f]*)
      echo "edd: ${image_tag_name} must be a 7-40 character lowercase hexadecimal Git commit prefix" >&2
      return 1
      ;;
  esac

  image_tag_length=$(printf '%s' "$image_tag_value" | wc -c | tr -d ' ')
  if [ "$image_tag_length" -lt 7 ] || [ "$image_tag_length" -gt 40 ]; then
    echo "edd: ${image_tag_name} must be a 7-40 character lowercase hexadecimal Git commit prefix" >&2
    return 1
  fi
}
