# Runs the Cortex-M4F build of the delay and reverb graph (m4_main.cpp) in the Unicorn emulator, like synth-open/tools/audio_opt/run_graph.py of the firmware repository
# (same CPU model and FPU setup). Run with python -I and a Python that has unicorn.
#   run.py <elf> <toolchain-prefix> <in.f32> <out.s16> <blocks> <cfg: 21 numbers> [block:index:value ...]
#   run.py <elf> <toolchain-prefix> expf <out.f32>      newlib's expf over fx::expfGrid (m4_main.cpp m4_expf)
import struct, subprocess, sys

BASE, SIZE = 0x20000000, 0xC00000
TRAP = BASE + SIZE - 0x1000


def sh(*a):
    return subprocess.run(a, check=True, capture_output=True, text=True).stdout


def main():
    elf, tc, inp, out = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
    blocks = int(sys.argv[5]) if inp != "expf" else 0
    cfg = [float(x) for x in sys.argv[6:27]] if inp != "expf" else []
    chg = [tuple(float(y) for y in x.split(':')) for x in sys.argv[27:]]
    from unicorn import UC_ARCH_ARM, UC_MODE_THUMB, Uc
    from unicorn.arm_const import UC_CPU_ARM_CORTEX_A15, UC_ARM_REG_C1_C0_2, UC_ARM_REG_FPEXC, UC_ARM_REG_LR, UC_ARM_REG_R0, UC_ARM_REG_SP
    subprocess.run([tc + "objcopy", "-O", "binary", "--gap-fill=0", elf, elf + ".bin"], check=True)
    image = open(elf + ".bin", "rb").read()
    syms = {}
    for line in sh(tc + "nm", "-C", "--defined-only", elf).splitlines():
        p = line.split(None, 2)
        if len(p) == 3:
            syms[p[2]] = int(p[0], 16)
    uc = Uc(UC_ARCH_ARM, UC_MODE_THUMB)
    uc.ctl_set_cpu_model(UC_CPU_ARM_CORTEX_A15)
    uc.mem_map(BASE, SIZE)
    uc.mem_write(BASE, image)
    uc.mem_write(TRAP, b"\xfe\xe7")
    uc.reg_write(UC_ARM_REG_C1_C0_2, uc.reg_read(UC_ARM_REG_C1_C0_2) | (0xF << 20))
    uc.reg_write(UC_ARM_REG_FPEXC, 0x40000000)

    def call(name):
        uc.reg_write(UC_ARM_REG_SP, TRAP - 0x1000)
        uc.reg_write(UC_ARM_REG_LR, TRAP | 1)
        uc.reg_write(UC_ARM_REG_R0, 0)
        uc.emu_start(syms[name] | 1, TRAP)

    if inp == "expf":
        call("m4_setup")
        call("m4_expf")
        open(out, "wb").write(bytes(uc.mem_read(syms["gExp"], 4 * 5097)))
        return
    data = open(inp, "rb").read()
    assert len(data) == blocks * 128 * 4
    uc.mem_write(syms["gCfg"], struct.pack("<21d", *cfg))
    uc.mem_write(syms["gBlocks"], struct.pack("<i", blocks))
    uc.mem_write(syms["gChgN"], struct.pack("<i", len(chg)))
    for i, c in enumerate(chg):
        uc.mem_write(syms["gChg"] + i * 24, struct.pack("<3d", *c))
    uc.mem_write(syms["gIn"], data)
    call("m4_setup")
    call("m4_run")
    open(out, "wb").write(bytes(uc.mem_read(syms["gOut"], blocks * 256 * 2)))


main()
