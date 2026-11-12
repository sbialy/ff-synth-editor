#!/bin/sh
# Vendor the OpenTracker 3.x module manifests (modules/<name>/module.toml) at a pinned commit.
# Usage: scripts/vendor-ot3.sh
#   manifests: https://github.com/opentracker-fw/opentracker-synths (MIT), commit SYNTHS_COMMIT
# Since the editor builds the engines from the tracker-ff firmware (scripts/vendor.sh, vendor/poly/synth-open/ot-synths, the same module
# sources at the same commit), this no longer copies any engine source or core header. What is left is what the firmware does not carry:
# the manifests, which nothing in the editor reads any more. Files are copied byte for byte. The clone goes into a new temp dir.
set -eu
SYNTHS_REPO="https://github.com/opentracker-fw/opentracker-synths.git"
SYNTHS_COMMIT="${SYNTHS_COMMIT:-eb150a5f741b6c3e7453592c24a128a358b07c46}"
MODULES="fm4 ju6 dtype cstype atype ttype eight hand btype arc"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
DST="$HERE/vendor/ot3"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/synths" "$TMP/out"
git clone -q --no-checkout "$SYNTHS_REPO" "$TMP/synths/repo"
S="$(git -C "$TMP/synths/repo" rev-parse "$SYNTHS_COMMIT^{commit}")"
SPATHS=""
for m in $MODULES; do SPATHS="$SPATHS modules/$m/module.toml"; done
git -C "$TMP/synths/repo" archive "$S" LICENSE $SPATHS | tar -x -C "$TMP/out"
rm -rf "$DST"; mkdir -p "$DST"
cp -R "$TMP/out/modules" "$DST/modules"
cp "$TMP/out/LICENSE" "$DST/LICENSE-opentracker-synths-MIT"
SD="$(git -C "$TMP/synths/repo" log -1 --format=%cs "$S")"
cat > "$DST/PROVENANCE.md" <<P
# Vendored OpenTracker 3.x module manifests

Written by scripts/vendor-ot3.sh. Every file is a byte for byte copy. Only the manifests are kept: the engines themselves are built from
the tracker-ff firmware (vendor/poly/synth-open/ot-synths, scripts/vendor.sh), which carries the same module sources.

- repository: https://github.com/opentracker-fw/opentracker-synths
- commit: $S ($SD), the commit the firmware's ot-synths files name
- licence: MIT, Copyright (c) 2026 Marcin Spoczynski (LICENSE-opentracker-synths-MIT)
- files: modules/<name>/module.toml for $MODULES (flash_max_bytes, cpu_insn_per_unit, max_units, sram_audio_bytes, id: read by server/engines.ts)
P
echo "vendored $(find "$DST" -type f | wc -l) files: synths $S"
