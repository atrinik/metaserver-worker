#!/usr/bin/env bash

set -euo pipefail
if [[ $# -ne 1 || ! $1 =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: $0 MAJOR.MINOR.PATCH" >&2
  exit 2
fi

version=$1
tag=v${version}
git cat-file -e "${tag}^{commit}"
wrangler_state=$(mktemp -d)
wrangler_log=${wrangler_state}/logs
trap 'rm -rf "${wrangler_state}"' EXIT
WRANGLER_LOG_PATH="${wrangler_log}" npm run deploy:dry-run

package=atrinik-metaserver-worker-${version}
output_directory=build/release
source_epoch=$(git show -s --format=%ct "${tag}^{commit}")
mkdir -p "${output_directory}"
tar --sort=name --mtime="@${source_epoch}" --owner=0 --group=0 --numeric-owner \
  --transform="s,^dist,${package}," \
  -czf "${output_directory}/${package}.tar.gz" dist
(
  cd "${output_directory}"
  sha256sum "${package}.tar.gz" >SHA256SUMS
)
