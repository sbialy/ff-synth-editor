#pragma once

#include "Core.h"

#include <algorithm>
#include <array>
#include <functional>
#include <optional>
#include <ranges>
#include <span>
#include <string>

namespace polysynth
{

class Musicology
{
  public:
    struct Chord
    {
        chordscheme_t scheme = Musicology::rootNoteChordScheme();
        note_t rootNote{};
        bool operator==(const Chord& rhs) const = default;
    };

    struct Scale
    {
        scalescheme_t scheme;
        note_t rootNote{};
        bool operator==(const Scale& other) const = default;
    };

    static Scale createScale(uint32_t scaleTypeIdx, note_t rootNote);
    static Chord alignToScale(const Chord& chord, const Scale& scale);

    static void alignToScale(polysynth::Musicology::Chord& chord,
                             const polysynth::Musicology::Scale& fromScale,
                             const polysynth::Musicology::Scale& toScale);

    static void transpose(polysynth::Musicology::Chord& chord,
                          const polysynth::Musicology::Scale& scale,
                          int delta);

    static void transpose(polysynth::Musicology::Chord& chord, int delta);

    static int transpose(note_t note,
                         const Musicology::Scale& fromScale,
                         const Musicology::Scale& toScale,
                         int semitones);

    /**
     * Toggles note in a chord on or off.
     * @param chord given chord
     * @param notePosition note position as an offset to chord root note
     */
    static void toggleChordNote(polysynth::Musicology::Chord& chord, int notePosition);

    static bool containsNote(const polysynth::Musicology::Chord& chord, note_t note);

    static bool isInRange(const polysynth::Musicology::Chord& chord, note_t note);

    static bool isWhiteKey(note_t note);

    /**
     * Finds note in scale by given interval and reference note.
     * @returns interval note_t in scale or std::nullopt if out range
     */
    static tiny_optional<note_t> getNoteByInterval(const Scale& scale,
                                                   note_t refNote,
                                                   int interval);

    /**
     * Finds same scale degree of @note in @toScale
     * Assumes @note is in @fromScale
     */
    static note_t sameDegreeNote(const Scale& fromScale, const Scale& toScale, note_t note);
    /**
     * determines the name of the Chord
     */
    static std::string chordName(const Chord& chord);

    /**
     * Normalize puts every note of chord into one octave. Useful when comparing chords.
     */
    static Chord normalize(const Chord& chord);

    /**
     * checks whether @chord fits @scale
     */
    static bool isInScale(const Chord& chord, const Scale& scale);

    /**
     * checks whether @note fits @scale
     */
    static bool isInScale(note_t note, const Scale& scale);

    /**
     * returns the number of notes in @scaleScheme
     */
    static size_t notesCount(const scalescheme_t& scaleScheme);

    static std::string scaleName(const Scale& scale);

    static std::string scaleSchemeName(const scalescheme_t& scaleScheme);

    static std::optional<chordscheme_t> getChordSchemeByName(std::string_view name);

    static void addToKeyboardScheme(keyboardscheme_t& keyboardScheme, const Chord& chord);
    /**
     * gets a chordcheme_t relative to given @chordScheme. Can be used to scan over defined chords.
     * @delta index difference in relationship to given chordScheme. For ex. +1 will return next
     * chordscheme, +2 -> one above next, -1 -> previous chord
     */
    static chordscheme_t getChordSchemeRelativeTo(const chordscheme_t& chordScheme, int delta);

    static chordscheme_t getChordSchemeRelativeTo(const Scale& scale,
                                                  const Chord& chord,
                                                  int delta);

    static scalescheme_t getScaleSchemeRelativeTo(const scalescheme_t& scaleScheme, int delta);

    [[maybe_unused]] static constexpr std::array kNoteSymbols{ "C ", "C#", "D ", "D#", "E ", "F ",
                                                               "F#", "G ", "G#", "A ", "A#", "B " };
    static std::string noteToString(note_t note, bool includeOctave = true);

    static constexpr int kScalesCount = 39;
    static constexpr int kChormaticScaleIdx = 0;
    [[maybe_unused]] static const std::array<const char*, kScalesCount> kScaleNames;

    static const chordscheme_t& rootNoteChordScheme();

    static constexpr chordscheme_t kEmptyChordScheme{
        0b00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
    };

    static constexpr scalescheme_t kChromaticScale{ 0b111111111111 };
    static void removeFromKeyboardScheme(keyboardscheme_t& keyboardScheme, const Chord& chord);

    /**
     * Helper function that can be used to iterate over notes in a chord.
     * @param chord from which to get notes
     * @return std::ranges::view of notes (uint8_t) in a chord.
     */
    static auto getNotesView(const Musicology::Chord& chord)
    {
#ifdef __clang__
        (void)chord;
        return std::array<uint8_t, 1>{ 0 };
#else
        int fromNote = std::max(kChordMaxWidth / 2 - chord.rootNote, 0);
        int toNote =
          std::min(kChordMaxWidth / 2 - chord.rootNote + kFullNotesRange, kFullNotesRange);

        return std::views::iota(fromNote, toNote) |
               std::views::filter([&chord](uint8_t note) { return chord.scheme[note]; }) |
               std::views::transform([&chord](uint8_t note)
                                     { return note + chord.rootNote - kChordMaxWidth / 2; });
#endif
    }

    static int getDegreeDiff(const Musicology::Scale& scale, note_t fromNote, note_t toNote);
};

}
