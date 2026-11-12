# FF SYNTH EDITOR

> Not affiliated with or endorsed by Polyend. Polyend and Tracker are trademarks of their owner.

A patch editor for the synth engines of tracker-ff, the community firmware for the original Polyend Tracker. It runs in your browser, plays the engines with the same code the firmware uses and saves `.patch` files your Tracker can load. This version matches **tracker-ff 1.2.0**.

**Open the editor: https://sbialy.github.io/ff-synth-editor/**

## Engines

- **OpenTracker 2.x:** ACD, FAT, VAP, WTFM, PERC
- **Polyend open source:** CHIP
- **OpenTracker 3.x:** FM4, JU6, D-Type, CS-Type, A-Type, T-Type, 8-Type, Hand-Type, B-Type, Arc-Type
- **FF-engines:** PHZ, Pluck

Master section: delay, reverb, mixer and limiter as on the Tracker, plus two insert slots with Dirt, Tape, Lo-Fi, BBD, Phaser, Console and Tube.

## How to use

1. Pick an engine. The patch list holds bundled starting patches. **Init** gives a blank patch.
2. **Open file** loads a `.patch` from your computer. The editor switches to the engine of the file.
3. Move the sliders. Double click a slider to reset it. Click a value and type a number such as `-6 dB`.
4. Press **Randomize** (or `R`) to roll a new sound. A seed gives the same sound every time. Undo and redo work as usual.
5. Play with the computer keys, the on-screen keyboard or a MIDI keyboard. Z and X shift the octave.
6. Type a name and **Save**. The browser downloads `<name>.patch`. Copy it to the patch folder of your Tracker.

Notes:

- Start audio with a click or a key press. Browsers keep sound off until then.
- MIDI input needs a browser with Web MIDI, such as Chrome. Safari has none.

## Run locally

```sh
bun install
bun run build
bun run start
```

Then open http://127.0.0.1:3210. This needs [bun](https://bun.sh) and a C++ compiler.

## Licence

The editor is MIT licensed, see [LICENSE](LICENSE). The licences of third party code and of the engine and insert modules are listed in [NOTICE.md](NOTICE.md).
