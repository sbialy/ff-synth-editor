# FF Synth Editor for tracker-ff 1.2.0

A patch editor for the synth engines of tracker-ff, the community firmware for the original Polyend Tracker. Shape a sound on your computer with the same engine code the Tracker runs, play it live from the computer keys or a MIDI keyboard and save it as a `.patch` file your Tracker loads.

This release matches tracker-ff 1.2.0. The page says so in its header.

## What is new since the last release

### All 18 engines of tracker-ff 1.2.0

- ACD, FAT, VAP, WTFM, PERC and CHIP
- the OpenTracker 3.x engines FM4, JU6, D-Type, CS-Type, A-Type, T-Type, 8-Type, Hand-Type, B-Type and Arc-Type. Hand-Type is now on the page.
- the FF-engines PHZ and Pluck, together in their own row

Pluck is the new Karplus-Strong plucked string engine. Two of its controls shape the sound further:

- **Vel Bright** makes soft notes sound darker
- **Body** adds the resonance of an instrument body

### The Tracker's master section

Below the engine controls you now hear and set what comes after the synth on the Tracker:

- **Delay** and **Reverb** with the settings of the Master Delay and Master Reverb pages. Each engine has its own Delay send and Reverb send. Delay Sync starts Off, as on the Tracker.
- **Mixer** with Hard Clip, Soft Clip and Soft Knee
- two **master insert** slots with Dirt, Tape, Lo-Fi, BBD, Phaser, Console and Tube
- the **Limiter** with Mode, Attack, Release and Threshold. It is on when the page opens, as on the Tracker. A Device defaults button puts it back.

Delay, reverb and limiter run the firmware's own code, so they sound the way your Tracker does.

### Finding and rating patches

- The patch list is now a search field. Type to filter by name, use the arrow keys to move and press Enter to load.
- Give a patch 0 to 5 stars from the header. The list shows the stars and can filter by a minimum rating and sort by rating. Ratings are saved in a `ratings.json` file next to the patches of each folder, so they travel with the folder.

### Editing

- Click any value readout and type a value, for example `-6 dB`, `250 ms` or `1.2 kHz`.
- The arrow keys step a focused slider to the next value the readout can show.
- Shift the keyboard octave with Z and X or the - and + buttons.
- The computer keys keep playing notes after you click a slider, a button or a star. Only a text field takes them.
- Macro readouts show one decimal, never a long raw number.

### Patch files

- Patches made on tracker-ff 1.2.0 can hold synth automation. The editor keeps it unchanged when you load and save the patch.
- A patch for an engine this editor does not have now shows a clear message instead of opening as an empty engine.

## How to run it

The quickest way is the hosted page, https://sbialy.github.io/ff-synth-editor/. To run the editor on your own computer you need [Bun](https://bun.sh) and a C++ compiler. In the editor folder:

```sh
bun install
bun run build
bun run start
```

Then open http://127.0.0.1:3210.

## Known limits

- Synth automation in a patch is kept but not shown or played.

Unofficial community tool, not affiliated with or endorsed by Polyend. Licences are listed in NOTICE.md.
