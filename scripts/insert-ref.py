#!/usr/bin/env python3
"""Reference renders of a master insert from its DEVICE file: the .plg's ARM code run in Unicorn by the firmware SDK's own harness
(synth-open/plug/emu_plug.py, the plugin loader re-done in Python). Writes test/fixtures/inserts/<id>-<scenario>.{in,out}.f32 and
<id>.json (the scenarios and the .plg sha256). test/modules.test.ts runs the .wasm twin on the same input and compares.

    /tmp/phzvenv/bin/python -I scripts/insert-ref.py --plg dirt.plg --emu path/to/emu_plug.py [--id dirt]   (id: dirt tape lofi console tube bbd phaser)

Needs a Python with unicorn. Run it again when the module set changes (modules.lock.json), the fixtures are data, not code.
"""
import argparse
import hashlib
import json
import math
import os
import struct
import subprocess
import sys
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "test", "fixtures", "inserts")

# The firmware's own non-default case per insert (synth-open/plug/build_plugs.sh nd(): every parameter moved, then one more change in block 5)
ND = {
    "dirt": "--param 0=2 --param 1=60 --param 2=8 --param 3=4 --param 4=70 --param 5=80 --param-at 5:1=20",
    "tape": "--param 0=80 --param 1=60 --param 2=40 --param 3=70 --param-at 5:0=10",
    "lofi": "--param 0=8 --param 1=2 --param 2=40 --param 3=1 --param 4=70 --param-at 5:0=6",
    "console": "--param 0=70 --param 1=80 --param 2=-3 --param 3=60 --param-at 5:0=20",
    "tube": "--param 0=70 --param 1=80 --param 2=40 --param 3=60 --param-at 5:0=20",
    "bbd": "--param 0=1 --param 1=60 --param 2=40 --param 3=90 --param-at 5:1=100",
    "phaser": "--param 0=1 --param 1=70 --param 2=50 --param 3=60 --param 4=100 --param 5=70 --param-at 5:0=0",
}


def scenarios(ident):
    """name -> (emu arguments, int16 wav input). default, nd (the firmware's non-default case) and bus (int16 input, the device bus: the chain
    test, int16 in and int16 out). Dirt has two more: asym (entering Asym) and its own bus settings."""
    nd = ND[ident].split()
    sc = {"default": ([], False), "nd": (nd, False)}
    if ident == "dirt":
        sc["asym"] = (["--param", "0=3", "--param", "1=90", "--param", "4=40", "--param-at", "10:0=0", "--param-at", "20:0=3"], False)
        sc["bus"] = (["--param", "1=75", "--param", "4=55"], True)
    else:
        sc["bus"] = (nd, True)
    return sc


def bus_wav(path, blocks):
    """A stereo int16 bus signal: two sines and a chirp, deterministic, 44.1 kHz."""
    w = wave.open(path, "wb")
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(44100)
    fr = []
    for n in range(blocks * 128):
        l = 0.45 * math.sin(2 * math.pi * 110 * n / 44100) + 0.3 * math.sin(2 * math.pi * (200 + n * 0.05) * n / 44100)
        r = 0.6 * math.sin(2 * math.pi * 330 * n / 44100 + 1.0)
        fr.append(struct.pack("<hh", int(round(l * 32767)), int(round(r * 32767))))
    w.writeframes(b"".join(fr))
    w.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--plg", required=True)
    ap.add_argument("--emu", required=True)
    ap.add_argument("--id", default="dirt")
    ap.add_argument("--blocks", type=int, default=64)
    a = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)
    rec = {"plg_sha256": hashlib.sha256(open(a.plg, "rb").read()).hexdigest(), "blocks": a.blocks, "harness": "synth-open/plug/emu_plug.py",
           "scenarios": {}}
    for name, (args, wav) in scenarios(a.id).items():
        extra = []
        if wav:
            p = os.path.join(OUT, "%s-%s.wav" % (a.id, name))
            bus_wav(p, a.blocks)
            extra = ["--inwav", p]
        prefix = os.path.join(OUT, "%s-%s" % (a.id, name))
        o = subprocess.run([sys.executable, "-I", a.emu, a.plg, "--blocks", str(a.blocks), "--raw", prefix] + args + extra,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        if o.returncode:
            sys.exit(o.stdout)
        if wav:
            os.remove(p)
        chk = [l for l in o.stdout.splitlines() if l.startswith("output checksum")][0].split()[2].rstrip(",")
        params, at = [], []
        for i in range(0, len(args), 2):
            if args[i] == "--param":
                k, v = args[i + 1].split("=")
                params.append([int(k), float(v)])
            else:
                b, rest = args[i + 1].split(":")
                k, v = rest.split("=")
                at.append([int(b), int(k), float(v)])
        rec["scenarios"][name] = {"params": params, "param_at": at, "int16_input": wav, "emu_checksum": chk}
        print("%s %s: checksum %s" % (a.id, name, chk))
    with open(os.path.join(OUT, a.id + ".json"), "w") as f:
        json.dump(rec, f, indent=1)
        f.write("\n")


if __name__ == "__main__":
    sys.exit(main())
