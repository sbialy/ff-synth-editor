#!/bin/sh
# Re-copy the firmware sources this editor builds against from a tracker-ff checkout (read-only source, never modified), at a tracker-ff RELEASE TAG.
# Usage: scripts/vendor.sh [tracker-ff-vX.Y.Z] [path-to-tracker-ff-checkout]      (default tag tracker-ff-v1.2.0, checkout from POLY_REPO)
# Maintainer tool: it needs local checkouts of tracker-ff and of the module repository (POLY_REPO, POLY_ENGINES_OS_REPO, no defaults).
# The editor is meant to match the firmware a user runs, so the pin is the release tag and nothing else: a raw commit is refused. The tag,
# its commit and the version go into vendor/FIRMWARE.json (generated, read by scripts/build.ts, the server, the page and test/sync.test.ts)
# and vendor/PROVENANCE.md. The version in the tag name must equal SYNTH_OPEN_VER of version.mk at that tag, or this script stops.
#
# Layout from tracker-ff 1.2.0 on: the firmware tree builds in only the stock six (synth-open/engines.mk SYNTH_ENGINES_ALL: ACD FAT VAP WTFM PERC CHIP).
# Every other engine is a card plugin (engines.mk SYNTH_ENGINES_EXT) whose source lives in a module repository, pinned by tag and commit in
# engines/external.lock.json of the firmware tag:
#  - engines-os (public): the ten OpenTracker 3.x module engines JU6 FM4 DTYPE CSTYPE ATYPE TTYPE 8TYPE HANDTYPE BTYPE ARCTYPE.
#    Their engine tables and DSP (src/synth-open/engine_<id>.cpp, ot-synths/<id>/) are read with git archive from the pinned commit of a local
#    checkout (POLY_ENGINES_OS_REPO) and compiled into the native host as before. The module
#    repository's vendored SDK (sdk/files/) must equal the firmware tag's files, or this script stops.
#  - engines (ff-engines, source not published): PHZ and PLK, our own. Their source is NOT copied: both run as runtime wasm modules (modules.lock.json,
#    scripts/modules.ts). The lock's engines set must name the tag and commit external.lock.json pins. Only POLY_PRIVATE_SOURCE=1 (maintainers) reads the
#    sources from that tag (checkout in POLY_ENGINES_REPO) into git ignored paths of vendor/poly, for the dev-only linked wasm reference.
# The release set is the stock six plus every engine row of engines/engines.json without an "optional" group, and the
# rows must be engines.mk SYNTH_ENGINES_EXT. FW_TRIM is never defined.
#
# Copies (everything read with git archive, never from a working tree: the checkout may be being edited): synth-open/ (shim, codec, the
# engine tables of the six, the OpenTracker core headers in ot/), the engines-os sources above, the open Chiptune voice core/synth/engines/ChiptuneSynthVoice,
# fmt, the exact header closure of the host build from synth/include, util/include and util/3rdparty, engines.mk and the licences. Then it applies
# scripts/shim.patch, the editor-only overlay (held notes, voices above the firmware cap), see the header of that file.
set -eu
TAG="${1:-${POLY_TAG:-tracker-ff-v1.2.0}}"
case "$TAG" in
  tracker-ff-v[0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "vendor.sh: '$TAG' is not a tracker-ff release tag (tracker-ff-vX.Y.Z). Raw commits are not accepted." >&2; exit 2 ;;
esac
REPO="${2:-${POLY_REPO:?vendor.sh: pass the tracker-ff checkout as the second argument or set POLY_REPO}}"
OS_REPO="${POLY_ENGINES_OS_REPO:?vendor.sh: set POLY_ENGINES_OS_REPO to a checkout of the module repository}"
PRIV_REPO="${POLY_ENGINES_REPO:-}"
VERSION="${TAG#tracker-ff-v}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
DST="$HERE/vendor"
COMMIT="$(git -C "$REPO" rev-parse --verify -q "refs/tags/$TAG^{commit}")" || { echo "vendor.sh: tag $TAG not found in $REPO" >&2; exit 1; }
TAGOBJ="$(git -C "$REPO" rev-parse "refs/tags/$TAG")"
COMMIT_DATE="$(git -C "$REPO" log -1 --format=%cs "$COMMIT")"
git -C "$REPO" cat-file -e "$COMMIT:engines/external.lock.json" 2>/dev/null || {
  echo "vendor.sh: $TAG has no engines/external.lock.json: this vendor.sh reads the module layout of tracker-ff 1.2.0 and later" >&2; exit 1; }
SRC="$(mktemp -d)"; OS="$(mktemp -d)"; PRIV="$(mktemp -d)"; trap 'rm -rf "$SRC" "$OS" "$PRIV"' EXIT
git -C "$REPO" archive "$COMMIT" synth synth-open util core/synth/engines licenses LICENSE version.mk engines/external.lock.json engines/engines.json | tar -x -C "$SRC"
cd "$SRC"
FWVER="$(sed -n 's/^SYNTH_OPEN_VER *:= *//p' version.mk | head -1)"
[ "$FWVER" = "$VERSION" ] || { echo "vendor.sh: tag $TAG says $VERSION but version.mk at that tag has SYNTH_OPEN_VER $FWVER" >&2; exit 1; }

jget() { python3 -I -c 'import json,sys
d=json.load(open(sys.argv[1]))
for k in sys.argv[2].split("."): d=d[k]
print(d)' "$@"; }

# ---- engine sets of the tag
BUILTIN="$(sed -n 's/^SYNTH_ENGINES_ALL *:= *//p' synth-open/engines.mk)"
DEFAULT_SET="$(sed -n 's/^SYNTH_ENGINES_DEFAULT *:= *//p' synth-open/engines.mk)"
STOCK="$(sed -n 's/^SYNTH_ENGINES_STOCK *:= *//p' synth-open/engines.mk)"
EXT="$(sed -n 's/^SYNTH_ENGINES_EXT *:= *//p' synth-open/engines.mk)"
[ -n "$BUILTIN" ] && [ -n "$EXT" ] || { echo "vendor.sh: synth-open/engines.mk at $TAG has no SYNTH_ENGINES_ALL or SYNTH_ENGINES_EXT" >&2; exit 1; }
[ "$BUILTIN" = "$STOCK" ] || { echo "vendor.sh: engines.mk at $TAG builds in '$BUILTIN' but the stock image is '$STOCK'" >&2; exit 1; }
# the plugin engines that ship (engines.json rows without an optional group): "NAME id repo stored patch" lines, checked against engine_list.h
ROWS="$(python3 -I -c 'import json,re,sys
el=open("synth-open/engine_list.h").read()
ext=sys.argv[2].split()
rows=[e for e in json.load(open(sys.argv[1]))["engines"] if not e.get("optional")]
if sorted(e["name"] for e in rows)!=sorted(ext): sys.exit("engines/engines.json ships %s but engines.mk SYNTH_ENGINES_EXT is %s" % (" ".join(e["name"] for e in rows), " ".join(ext)))
for e in rows:
    m=re.search(r"SYNTH_ENGINE\(%s, (\d+), [^\n]*?, \w+, \w+, (0x[0-9A-Fa-f]+|\d+)," % re.escape(e["name"]), el)
    if not m or int(m.group(1))!=e["stored"] or int(m.group(2),0)!=e["patch"]: sys.exit("%s: engines.json stored %d patch %d, engine_list.h %s" % (e["name"],e["stored"],e["patch"],m and m.group(0)))
    print(e["name"], e["id"], e["repo"], e["stored"], e["patch"])' engines/engines.json "$EXT")" || { echo "vendor.sh: engine rows of $TAG do not agree (above)" >&2; exit 1; }
# every engine in the order of engine_list.h (the firmware's model list order)
ORDER="$(sed -n 's/^SYNTH_ENGINE(\([A-Z0-9]*\),.*/\1/p' synth-open/engine_list.h | tr '\n' ' ')"
ALL=""; for e in $ORDER; do case " $BUILTIN $EXT " in *" $e "*) ALL="$ALL $e" ;; esac; done; ALL="${ALL# }"
for e in $BUILTIN $EXT; do case " $ALL " in *" $e "*) ;; *) echo "vendor.sh: $e has no SYNTH_ENGINE line in engine_list.h at $TAG" >&2; exit 1 ;; esac; done
RELEASE="$ALL"

# ---- module repositories pinned by engines/external.lock.json
OS_TAG="$(jget engines/external.lock.json sets.engines-os.tag)"
OS_COMMIT="$(jget engines/external.lock.json sets.engines-os.tag_commit)"
OS_REPO_NAME="$(jget engines/external.lock.json sets.engines-os.repo)"
GOT="$(git -C "$OS_REPO" rev-parse --verify -q "refs/tags/$OS_TAG^{commit}")" || { echo "vendor.sh: tag $OS_TAG (external.lock.json engines-os) not found in $OS_REPO" >&2; exit 1; }
[ "$GOT" = "$OS_COMMIT" ] || { echo "vendor.sh: $OS_TAG is $GOT in $OS_REPO but $TAG external.lock.json pins $OS_COMMIT" >&2; exit 1; }
git -C "$OS_REPO" archive "$OS_COMMIT" engines.json src/synth-open sdk/files licenses | tar -x -C "$OS"
# the module repository must have been built against this very SDK
( cd "$OS/sdk/files" && find . -type f | sed 's|^\./||' | sort ) > "$OS/sdkfiles"
while read -r f; do cmp -s "$OS/sdk/files/$f" "$SRC/$f" || { echo "vendor.sh: $OS_REPO_NAME $OS_TAG sdk/files/$f differs from $TAG" >&2; exit 1; }; done < "$OS/sdkfiles"
OS_ROWS="$(python3 -I -c 'import json,sys
for e in json.load(open(sys.argv[1]))["engines"]: print(e["name"], e["def"], e["dsp"], e["stored"], e["patch"])' "$OS/engines.json")"
OS_ENGINES=""; OS_SRCS=""
while read -r name def dsp stored patch; do
  case " $EXT " in *" $name "*) ;; *) echo "vendor.sh: $OS_REPO_NAME $OS_TAG builds $name, which $TAG does not ship" >&2; exit 1 ;; esac
  echo "$ROWS" | grep -q "^$name [a-z0-9]* tracker-engines-os $stored $patch\$" || { echo "vendor.sh: $name numbers in $OS_REPO_NAME ($stored/$patch) are not the ones of $TAG engines/engines.json" >&2; exit 1; }
  OS_ENGINES="$OS_ENGINES $name"; OS_SRCS="$OS_SRCS synth-open/$def synth-open/$dsp"
done <<EOF
$OS_ROWS
EOF
OS_ENGINES="${OS_ENGINES# }"
cp -R "$OS/src/synth-open/." "$SRC/synth-open/"
rm -rf "$SRC/synth-open/plug/synth"   # the card plugin wrappers (plug/synth/*_plug.cpp) are not the editor's

PRIV_TAG="$(jget engines/external.lock.json sets.engines.tag)"
PRIV_COMMIT="$(jget engines/external.lock.json sets.engines.tag_commit)"
PRIV_ENGINES="$(echo "$ROWS" | awk '$3 != "tracker-engines-os" {print $1}' | tr '\n' ' ' | sed 's/ $//')"
for e in $EXT; do case " $OS_ENGINES $PRIV_ENGINES " in *" $e "*) ;; *) echo "vendor.sh: no module repository builds $e" >&2; exit 1 ;; esac; done
LOCK="$HERE/modules.lock.json"
# modules.lock.json must pin the module releases the firmware tag pins: per set the repository, tag and commit, and for the public sets the sha256 of every
# .wasm and .json and of the notice files (the published release assets). The private engines set may override one engine with a later commit ("overrides"),
# every other file of a private set is not checked here (the firmware lock pins no editor-only file of them).
python3 -I -c 'import json,sys
ext=json.load(open(sys.argv[1]))["sets"]; lock=json.load(open(sys.argv[2]))["sets"]; bad=[]
for n in ("engines-os","effects-os","engines","effects"):
    e=ext.get(n); l=lock.get(n)
    if not e or not l: bad.append("set %s missing (firmware %s, editor %s)" % (n, bool(e), bool(l))); continue
    for k in ("repo","tag","tag_commit"):
        # the private sets pin the re-issued releases engines-v1.2.1 and effects-v1.0.1 (same .wasm, manifests without a private repository name)
        if k!="repo" and e["visibility"]=="private": continue
        if e[k]!=l.get(k): bad.append("%s %s: firmware %s, editor %s" % (n,k,e[k],l.get(k)))
    want={f:h for f,h in list(e["files"].items())+list(e.get("notice_files",{}).items()) if f.endswith((".wasm",".json",".md",".txt"))}
    ovr=set(i+x for i in l.get("overrides",{}) for x in (".wasm",".json"))
    for f,h in want.items():
        if f in ovr: continue
        if f in l["files"] and l["files"][f]!=h: bad.append("%s %s: firmware sha256 %s, editor %s" % (n,f,h,l["files"][f]))
        elif f not in l["files"] and e["visibility"]=="public": bad.append("%s %s: pinned by the firmware, not in modules.lock.json" % (n,f))
if bad: sys.exit("\n".join(bad))' engines/external.lock.json "$LOCK" || {
  echo "vendor.sh: modules.lock.json does not pin the module releases $TAG engines/external.lock.json pins (above)" >&2; exit 1; }
# PLK override: "commit wasm_sha256 plg_sha256" or empty
PLK_OVR="$(python3 -I -c 'import json,sys
o=json.load(open(sys.argv[1]))["sets"]["engines"].get("overrides",{}).get("pluck")
print("%s %s %s %s" % (o["commit"], o["version"], o["wasm_sha256"], o.get("plg_sha256","")) if o else "")' "$LOCK")"
PLK_OVR_COMMIT="${PLK_OVR%% *}"
# the unpublished sources (their src/ layout is the firmware's synth-open/ layout) and where they sit in vendor/poly
PRIV_FILES="synth-open/engine_phz.cpp synth-open/phz/phz.cpp synth-open/phz/phz.h synth-open/engine_pluck.cpp synth-open/pluck/pluck.cpp synth-open/pluck/pluck.h"
if [ "${POLY_PRIVATE_SOURCE:-0}" = 1 ]; then
  [ -n "$PRIV_REPO" ] || { echo "vendor.sh: POLY_PRIVATE_SOURCE=1 needs POLY_ENGINES_REPO, a checkout of the engines repository" >&2; exit 1; }
  GOT="$(git -C "$PRIV_REPO" rev-parse --verify -q "refs/tags/$PRIV_TAG^{commit}")" || { echo "vendor.sh: tag $PRIV_TAG not found in $PRIV_REPO" >&2; exit 1; }
  [ "$GOT" = "$PRIV_COMMIT" ] || { echo "vendor.sh: $PRIV_TAG is $GOT in $PRIV_REPO but external.lock.json says $PRIV_COMMIT" >&2; exit 1; }
  git -C "$PRIV_REPO" archive "$PRIV_COMMIT" $(for f in $PRIV_FILES; do echo "src/$f"; done) | tar -x -C "$PRIV"
  cp -R "$PRIV/src/synth-open/." "$SRC/synth-open/"
  if [ -n "$PLK_OVR" ]; then   # PLK from the override commit, so the linked reference is the engine the runtime module was built from
    git -C "$PRIV_REPO" cat-file -e "$PLK_OVR_COMMIT^{commit}" || { echo "vendor.sh: override commit $PLK_OVR_COMMIT not found in $PRIV_REPO" >&2; exit 1; }
    git -C "$PRIV_REPO" archive "$PLK_OVR_COMMIT" src/synth-open/engine_pluck.cpp src/synth-open/pluck | tar -x -C "$PRIV"
    cp -R "$PRIV/src/synth-open/." "$SRC/synth-open/"
  fi
fi

# ---- the sources the host compiles: the six from engines.mk, the engines-os ones from the module repository
printf 'probe:\n\t@echo "SRCS=$(SYNTH_ENGINE_SRCS)"\n\t@echo "CORE=$(foreach e,$(SYNTH_ENGINES_SEL),$(SYNTH_ENGINE_CORE_SRCS_$(e)))"\n' > "$SRC/probe.mk"
PROBE="$(make -s -f synth-open/engines.mk -f "$SRC/probe.mk" probe SYNTH_ENGINES="$BUILTIN")"
ENGINE_SRCS="$(echo "$PROBE" | sed -n 's/^SRCS=//p')"
CORE_SRCS="$(echo "$PROBE" | sed -n 's/^CORE=//p')"
[ -n "$ENGINE_SRCS" ] || { echo "vendor.sh: could not read the engine sources from synth-open/engines.mk" >&2; exit 1; }
COMMON="synth-open/open_synth.cpp synth-open/open_cold.cpp synth-open/open_patchio.cpp synth-open/ot/audio/governor.cpp synth-open/ot/audio/cpu_meter.cpp"
SO_ALL="$COMMON"; for f in $ENGINE_SRCS; do SO_ALL="$SO_ALL synth-open/$f"; done; SO_ALL="$SO_ALL $OS_SRCS"; for f in $CORE_SRCS; do SO_ALL="$SO_ALL core/$f"; done
for f in $SO_ALL; do [ -f "$f" ] || { echo "vendor.sh: $f is missing" >&2; exit 1; }; done
# the private sources are listed in FIRMWARE.json "sources" (scripts/build.ts leaves them out), the header closure takes them only with POLY_PRIVATE_SOURCE=1
SO_ALL="$SO_ALL synth-open/engine_phz.cpp synth-open/phz/phz.cpp synth-open/engine_pluck.cpp synth-open/pluck/pluck.cpp"
SO=""; for f in $SO_ALL; do case " $PRIV_FILES " in *" $f "*) [ "${POLY_PRIVATE_SOURCE:-0}" = 1 ] && SO="$SO $f" ;; *) SO="$SO $f" ;; esac; done
DEFS=""; for e in $ALL; do case " $PRIV_ENGINES " in *" $e "*) [ "${POLY_PRIVATE_SOURCE:-0}" = 1 ] && DEFS="$DEFS -DSYNTH_ENGINE_$e" ;; *) DEFS="$DEFS -DSYNTH_ENGINE_$e" ;; esac; done

rm -rf "$DST/poly"; mkdir -p "$DST/poly"
# header closure, computed by the compiler (x86_64, as the host build)
DEPS="$(clang++ -arch x86_64 -std=c++20 -M -I "$HERE/host/compat" -I synth/include -I util/include -I util/3rdparty -I synth-open -I synth-open/ot -I "$HERE/host" -I core/synth -I core/synth/engines \
  "-D_GLIBCXX_THROW_OR_ABORT(x)=__builtin_abort()" -DFEATURE_SYNTH_OPEN -DOPEN_HOST_TEST $DEFS $SO | tr -s ' \\\n' '\n' | grep -E '^(synth|util|synth-open|core)/.*\.(h|hpp)$' | sort -u)"
{ echo $SO | tr ' ' '\n'; echo "$DEPS"; echo synth-open/engines.mk; ls synth-open/*.h synth-open/ot/audio/*.h synth-open/ot/audio/engines/*.h synth-open/ot/model/*.h synth-open/ot/*.h synth-open/ot-synths/*/*.h; } | sort -u | while read -r f; do
  mkdir -p "$DST/poly/$(dirname "$f")"; cp "$f" "$DST/poly/$f"
done
if [ "${POLY_PRIVATE_SOURCE:-0}" = 1 ]; then
  for f in $PRIV_FILES; do mkdir -p "$DST/poly/$(dirname "$f")"; cp "$f" "$DST/poly/$f"; done   # git ignored, see .gitignore
fi
cp util/3rdparty/fmt/format.cc util/3rdparty/fmt/format-inl.h "$DST/poly/util/3rdparty/fmt/"
cp util/3rdparty/fmt/LICENSE.rst "$DST/poly/LICENSE-fmt-MIT.rst"
cp LICENSE "$DST/poly/LICENSE-tracker-ce-MIT-clone-restriction"
cp licenses/LICENSE-OpenTracker-Apache-2.0.txt "$DST/poly/LICENSE-OpenTracker-Apache-2.0"
cp "$OS/licenses/LICENSE-OpenTracker-synths-MIT.txt" "$DST/poly/LICENSE-OpenTracker-synths-MIT"
cp util/3rdparty/tiny/LICENSE "$DST/poly/LICENSE-Boost-1.0"
# Local overlay, see the header of scripts/shim.patch
patch -p1 -d "$DST/poly" --no-backup-if-mismatch -s < "$HERE/scripts/shim.patch"

json_list() { first=1; printf '['; for x in "$@"; do [ $first = 1 ] || printf ', '; first=0; printf '"%s"' "$x"; done; printf ']'; }
SRCLIST=""; for f in $SO_ALL; do SRCLIST="$SRCLIST $f"; done
cat > "$DST/FIRMWARE.json" <<J
{
  "name": "tracker-ff",
  "tag": "$TAG",
  "version": "$VERSION",
  "commit": "$COMMIT",
  "tagObject": "$TAGOBJ",
  "commitDate": "$COMMIT_DATE",
  "label": "tracker-ff $VERSION",
  "engines": $(json_list $ALL),
  "builtinEngines": $(json_list $BUILTIN),
  "defaultEngines": $(json_list $DEFAULT_SET),
  "releaseEngines": $(json_list $RELEASE),
  "notInRelease": [],
  "modules": {
    "repo": "$OS_REPO_NAME",
    "tag": "$OS_TAG",
    "commit": "$OS_COMMIT",
    "engines": $(json_list $OS_ENGINES),
    "files": $(json_list $OS_SRCS)
  },
  "private": {
    "repo": "ff-engines",
    "tag": "$PRIV_TAG",
    "commit": "$PRIV_COMMIT",
    "override": $(if [ -n "$PLK_OVR" ]; then set -- $PLK_OVR; printf '{"engine": "PLK", "commit": "%s", "version": "%s", "wasm_sha256": "%s", "plg_sha256": "%s"}' "$1" "$2" "$3" "${4:-}"; else printf null; fi),
    "engines": $(json_list $PRIV_ENGINES),
    "files": $(json_list $PRIV_FILES)
  },
  "sources": $(json_list $SRCLIST)
}
J
OVR_LINE=""
if [ -n "$PLK_OVR" ]; then set -- $PLK_OVR
  OVR_LINE="- override: PLK (pluck.wasm and pluck.json of the engines set) is not the one of the tag, it is PLK $2 built from ff-engines commit $1 (adds Vel Bright and Body, bit identical to PLK 1.0 of the tag with both at their default 0), the PLK of the tracker-ff $VERSION release zip (pluck.plg sha256 $4). Every other file of the set is the tag's
"
fi
cat > "$DST/PROVENANCE.md" <<P
# Vendored sources

Copied verbatim by scripts/vendor.sh, read with git archive from the release tag of tracker-ff and from the module repository
tag that the firmware tag pins in engines/external.lock.json (never from a working tree).
From tracker-ff 1.2.0 on, the firmware tree builds in only the stock six engines. The ten OpenTracker 3.x module engines are card plugins whose
source is in $OS_REPO_NAME: their engine tables and DSP (synth-open/engine_<id>.cpp, synth-open/ot-synths/) come from that repository at the
pinned commit and are compiled into the editor's host. vendor.sh checks that the SDK files that repository vendors equal the firmware tag's.
The sources of PHZ and PLK are not copied: they are our own and not published. Both engines run as runtime wasm modules (modules.lock.json).
The only edits are the hunks of scripts/shim.patch (applied after the copy, header of that file): the held-note registry
(SynthParams::held) with Poly 1 note priority and two EngineDef fields for it (A-Type), the shim voice records lifted from 4 to 8
(open::kEditorMaxVoices, a computer-only preview, the firmware cap stays in EngineDef::maxVoices) and open::voicesHeld().
Everything else is byte for byte the source. vendor/FIRMWARE.json is generated (tag, commit, engine set, the sources to compile).
vendor/ot3 holds only the OpenTracker module manifests (module.toml, flash and CPU budgets), see vendor/ot3/PROVENANCE.md.
Licence of the tracker-ce parts: upstream (polyend/tracker-ce) replaced PolyForm Noncommercial 1.0.0 with Polyend additional permissions by the MIT License with a Wholesale Commercial
Clone Restriction on 2026-11-03 (commit 9cc7aae). The tags tracker-ff-v1.1.0 and v1.2.0 carry the new text, vendor/poly/LICENSE-tracker-ce-MIT-clone-restriction is that LICENSE file byte for byte.

- firmware: tracker-ff $VERSION
- tag: $TAG (tag object $TAGOBJ)
- commit: $COMMIT ($COMMIT_DATE)
- built into the firmware: $BUILTIN
- plugin engines: $EXT
- release image: $RELEASE
- OpenTracker module engines: $OS_ENGINES from $OS_REPO_NAME $OS_TAG (commit $OS_COMMIT)
- closed source: $PRIV_ENGINES are runtime modules, built from ff-engines $PRIV_TAG (commit $PRIV_COMMIT). Their source is not in this repository and not copied here
$OVR_LINE
Contents of vendor/poly:

| Path | Origin | Licence |
|---|---|---|
| synth-open/*.cpp *.h (shim, codec, engine tables of the six) | tracker-ff synth-open | Polyend Tracker Community Edition License (MIT License with Wholesale Commercial Clone Restriction): LICENSE-tracker-ce-MIT-clone-restriction (the tag's LICENSE, unchanged) |
| synth-open/engine_{ju6,fm4,dtype,cstype,atype,ttype,eight,hand,btype,arc}.cpp | $OS_REPO_NAME $OS_TAG src/synth-open/ | MIT: LICENSE-OpenTracker-synths-MIT |
| synth-open/ot/ | OpenTracker (https://github.com/sandlbn/polyend-tracker-re): 2.x commit 927b1516385e, except audio/synth_engine.h, bbd_chorus.h and the chip, fm and va DSP headers from the 3.x branch v3_fixes | Apache-2.0: LICENSE-OpenTracker-Apache-2.0, files keep their provenance line |
| synth-open/ot-synths/ | opentracker-synths (https://github.com/opentracker-fw/opentracker-synths) commit eb150a5f741b, as shipped in $OS_REPO_NAME $OS_TAG | MIT: LICENSE-OpenTracker-synths-MIT |
| (no PHZ or PLK source) | PHZ and PLK are runtime modules built from their own repository (ff-engines, source not published), see modules.lock.json | proprietary freeware (LICENSE.md that ships with the modules), Apache-2.0 for the VAP derived voice skeleton of PHZ |
| synth/include/PolySynth/ (headers only) | tracker-ff | as the shim |
| util/include/PolyUtil/misc.h | tracker-ff | as the shim |
| util/3rdparty/boost, tiny (header closure only) | Boost 1.80.0, tiny::optional | Boost Software License 1.0: LICENSE-Boost-1.0 |
| core/synth/engines/ChiptuneSynthVoice.cpp .h | tracker-ff, the open Chiptune engine (CHIP), with the tracker-ff FEATURE_SYNTH_OPEN block | as the shim |
| util/3rdparty/fmt (headers and format.cc) | {fmt} as shipped in tracker-ff | MIT: LICENSE-fmt-MIT.rst |

The closed libraries synth/lib/*.a are not copied and not linked.

Copyright (c) 2020-2026 Polyend Sp. z o.o. and Polyend Tracker Community Edition Contributors (https://github.com/polyend/tracker-ce), MIT License with Wholesale Commercial Clone Restriction, text in vendor/poly/LICENSE-tracker-ce-MIT-clone-restriction
P
echo "vendored $(find "$DST/poly" -type f | wc -l | tr -d ' ') files from tracker-ff $VERSION ($TAG, $COMMIT) and $OS_REPO_NAME $OS_TAG"
