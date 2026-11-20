#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
tmp="$(mktemp -d)"
cp pubspec.yaml "$tmp/pubspec.yaml"
cp analysis_options.yaml "$tmp/analysis_options.yaml"
cp -a lib "$tmp/lib"
cp -a test "$tmp/test"
flutter create --platforms=android,ios --org ir.heyat --project-name hamyar_heyat .
cp "$tmp/pubspec.yaml" pubspec.yaml
cp "$tmp/analysis_options.yaml" analysis_options.yaml
rm -rf lib test
cp -a "$tmp/lib" lib
cp -a "$tmp/test" test
python3 scripts/patch_platforms.py
