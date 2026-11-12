# Vendored sources

Copied verbatim by scripts/vendor.sh, read with git archive from the release tag of tracker-ff and from the module repository
tag that the firmware tag pins in engines/external.lock.json (never from a working tree).
From tracker-ff 1.2.0 on, the firmware tree builds in only the stock six engines. The ten OpenTracker 3.x module engines are card plugins whose
source is in sbialy/tracker-engines-os: their engine tables and DSP (synth-open/engine_<id>.cpp, synth-open/ot-synths/) come from that repository at the
pinned commit and are compiled into the editor's host. vendor.sh checks that the SDK files that repository vendors equal the firmware tag's.
The sources of PHZ and PLK are not copied: they are our own and not published. Both engines run as runtime wasm modules (modules.lock.json).
The only edits are the hunks of scripts/shim.patch (applied after the copy, header of that file): the held-note registry
(SynthParams::held) with Poly 1 note priority and two EngineDef fields for it (A-Type), the shim voice records lifted from 4 to 8
(open::kEditorMaxVoices, a computer-only preview, the firmware cap stays in EngineDef::maxVoices) and open::voicesHeld().
Everything else is byte for byte the source. vendor/FIRMWARE.json is generated (tag, commit, engine set, the sources to compile).
vendor/ot3 holds only the OpenTracker module manifests (module.toml, flash and CPU budgets), see vendor/ot3/PROVENANCE.md.
Licence of the tracker-ce parts: upstream (polyend/tracker-ce) replaced PolyForm Noncommercial 1.0.0 with Polyend additional permissions by the MIT License with a Wholesale Commercial
Clone Restriction on 2026-11-03 (commit 9cc7aae). The tags tracker-ff-v1.1.0 and v1.2.0 carry the new text, vendor/poly/LICENSE-tracker-ce-MIT-clone-restriction is that LICENSE file byte for byte.

- firmware: tracker-ff 1.2.0
- tag: tracker-ff-v1.2.0 (tag object 9c3b9b80fb4e75b50509e8cf0d4a5ff5b1bf5cb9)
- commit: 9ef9dc54c3953d7ac8777b3e99383f5f8ccc992d (2026-11-09)
- built into the firmware: ACD FAT VAP WTFM PERC CHIP
- plugin engines: JU6 FM4 DTYPE CSTYPE ATYPE TTYPE 8TYPE HANDTYPE BTYPE ARCTYPE PHZ PLK
- release image: ACD FAT VAP WTFM PERC CHIP JU6 PHZ FM4 DTYPE CSTYPE ATYPE TTYPE 8TYPE HANDTYPE BTYPE ARCTYPE PLK
- OpenTracker module engines: JU6 FM4 BTYPE DTYPE CSTYPE ATYPE TTYPE 8TYPE HANDTYPE ARCTYPE from sbialy/tracker-engines-os v1.2.0 (commit f20ded8ad84e8acb6ea61f3c8b7c4fa7653af718)
- closed source: PHZ PLK are runtime modules, built from ff-engines engines-v1.2.0 (commit 3ec1380b9ffc9f4db990cfee72f4d4a6a5bf2e8e). Their source is not in this repository and not copied here
- override: PLK (pluck.wasm and pluck.json of the engines set) is not the one of the tag, it is PLK 1.1.0 built from ff-engines commit e2ce0b5fe5ae8e97a68652b8db5f90772fd7dbef (adds Vel Bright and Body, bit identical to PLK 1.0 of the tag with both at their default 0), the PLK of the tracker-ff 1.2.0 release zip (pluck.plg sha256 fcabdc0ac8b540f02b3c62b1bc6749a08d1486e899a7629d57411aa018500bc0). Every other file of the set is the tag's

Contents of vendor/poly:

| Path | Origin | Licence |
|---|---|---|
| synth-open/*.cpp *.h (shim, codec, engine tables of the six) | tracker-ff synth-open | Polyend Tracker Community Edition License (MIT License with Wholesale Commercial Clone Restriction): LICENSE-tracker-ce-MIT-clone-restriction (the tag's LICENSE, unchanged) |
| synth-open/engine_{ju6,fm4,dtype,cstype,atype,ttype,eight,hand,btype,arc}.cpp | sbialy/tracker-engines-os v1.2.0 src/synth-open/ | MIT: LICENSE-OpenTracker-synths-MIT |
| synth-open/ot/ | OpenTracker (https://github.com/sandlbn/polyend-tracker-re): 2.x commit 927b1516385e, except audio/synth_engine.h, bbd_chorus.h and the chip, fm and va DSP headers from the 3.x branch v3_fixes | Apache-2.0: LICENSE-OpenTracker-Apache-2.0, files keep their provenance line |
| synth-open/ot-synths/ | opentracker-synths (https://github.com/opentracker-fw/opentracker-synths) commit eb150a5f741b, as shipped in sbialy/tracker-engines-os v1.2.0 | MIT: LICENSE-OpenTracker-synths-MIT |
| (no PHZ or PLK source) | PHZ and PLK are runtime modules built from their own repository (ff-engines, source not published), see modules.lock.json | proprietary freeware (LICENSE.md that ships with the modules), Apache-2.0 for the VAP derived voice skeleton of PHZ |
| synth/include/PolySynth/ (headers only) | tracker-ff | as the shim |
| util/include/PolyUtil/misc.h | tracker-ff | as the shim |
| util/3rdparty/boost, tiny (header closure only) | Boost 1.80.0, tiny::optional | Boost Software License 1.0: LICENSE-Boost-1.0 |
| core/synth/engines/ChiptuneSynthVoice.cpp .h | tracker-ff, the open Chiptune engine (CHIP), with the tracker-ff FEATURE_SYNTH_OPEN block | as the shim |
| util/3rdparty/fmt (headers and format.cc) | {fmt} as shipped in tracker-ff | MIT: LICENSE-fmt-MIT.rst |

The closed libraries synth/lib/*.a are not copied and not linked.

Copyright (c) 2020-2026 Polyend Sp. z o.o. and Polyend Tracker Community Edition Contributors (https://github.com/polyend/tracker-ce), MIT License with Wholesale Commercial Clone Restriction, text in vendor/poly/LICENSE-tracker-ce-MIT-clone-restriction
