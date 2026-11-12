# Vendored OpenTracker 3.x module manifests

Written by scripts/vendor-ot3.sh. Every file is a byte for byte copy. Only the manifests are kept: the engines themselves are built from
the tracker-ff firmware (vendor/poly/synth-open/ot-synths, scripts/vendor.sh), which carries the same module sources.

- repository: https://github.com/opentracker-fw/opentracker-synths
- commit: eb150a5f741b6c3e7453592c24a128a358b07c46 (2026-11-01), the commit the firmware's ot-synths files name
- licence: MIT, Copyright (c) 2026 Marcin Spoczynski (LICENSE-opentracker-synths-MIT)
- files: modules/<name>/module.toml for fm4 ju6 dtype cstype atype ttype eight hand btype arc (flash_max_bytes, cpu_insn_per_unit, max_units, sram_audio_bytes, id: read by server/engines.ts)
