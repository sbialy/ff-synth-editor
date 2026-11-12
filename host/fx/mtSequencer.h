// Stand-in for the firmware's mtSequencer.h: the delay's tempo sync reads the tempo from `sequencer`. The editor has no sequencer, the page sets the tempo.
#pragma once
struct EditorSequencer
{
    float tempo = 130.0f; // DEFAULT_TEMPO of the firmware
    float getCurrentTempo() const { return tempo; }
};
extern EditorSequencer sequencer;
