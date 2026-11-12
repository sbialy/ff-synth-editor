#pragma once

#include <bitset>
#include <cstdint>
#include <optional>

#include "PolyUtil/misc.h"
#include "config.h"

namespace polysynth
{
using note_t = int;
static constexpr int kChordMaxWidth = 128;
using chordscheme_t = std::bitset<kChordMaxWidth>;

static constexpr note_t kOneOctaveNotes = 12;
using scalescheme_t = std::bitset<kOneOctaveNotes>;

static constexpr note_t kFullNotesRange = 128;
using keyboardscheme_t = std::bitset<kFullNotesRange>;

static constexpr note_t kNoteC0 = 12;
static constexpr note_t kNoteC1 = 24;
static constexpr note_t kNoteC4 = 60;
static constexpr note_t kNoteA4 = 69; // A4 concert pitch 440 Hz
static constexpr note_t kNoteB8 = 119;

static constexpr note_t kNoteMax = kNoteB8;
static constexpr note_t kNoteMin = kNoteC0 - kOneOctaveNotes;

struct Sample
{
    std::string name;
    std::span<sample_store_t> data;
    struct Format
    {
        int channels;
        int sampleRate;

    } format;
    tiny_optional<int> waveSize = std::nullopt;
};

enum class LoadStatus
{
    kSuccess,
    kFileError,
    kOutOfMemoryError,
};

}
