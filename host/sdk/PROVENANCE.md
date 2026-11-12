# host/sdk

`plug_abi.h` and `plug_wasm.h` are the public plugin SDK headers of the firmware (`synth-open/plug/` of tracker-ff). They are copied here by
hand for the runtime module build (scripts/build-wasm.ts). When vendor/ moves to a release that ships `synth-open/plug/`,
vendor.sh copies them and this folder goes away. test/modules.test.ts checks the copies against the module manifests' ABI.

Licence: `plug_abi.h` and `plug_wasm.h` are MIT, Copyright (c) 2026 sbialy (tracker-ff), the text of `synth-open/plug/LICENSE` of tracker-ff-v1.2.0 is `LICENSE-tracker-ff-plug-sdk-MIT` next to them. `plug_rt_wasm.c` is the wasm twin of `plug_rt.c` of that SDK and states no licence of its own in its header.
