#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
tmp="$(mktemp -d)"
cp pubspec.yaml "$tmp/pubspec.yaml"
cp -a lib "$tmp/lib"
flutter create --platforms=android,ios --org ir.heyat --project-name hamyar_heyat .
cp "$tmp/pubspec.yaml" pubspec.yaml
rm -rf lib
cp -a "$tmp/lib" lib
python3 scripts/patch_platforms.py
