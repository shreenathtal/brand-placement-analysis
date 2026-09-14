#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
exec npx tsx scripts/build-obscure-brand-test-video.mjs
