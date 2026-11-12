// wasm build only: MidiSink is only forward declared in the vendored firmware (Synth.h:24). The newer libc++ of emscripten refuses
// ~unique_ptr<incomplete>, Apple libc++ accepts it. Nothing in the build defines or creates one, so an empty definition is safe.
#pragma once
namespace polysynth { class MidiSink { public: virtual ~MidiSink() = default; }; }
