// Open PolySynth shim for MK66 - copy of the patch bank files of a part between two folders (project save and load).
// Plain C++ over a small file operations type, so the host smoke test runs the same code with an in-memory card that fails on request.
#pragma once

#include "open_fileops.h"
#include "open_load.h"

#include <cstdint>
#include <string>

namespace polysynth::open
{

// The files of a part: its slot files 0..15, the slot 0 backup and the slot names, in this order. Name without folder.
constexpr int kBankFiles = kBackupSlot + 2;
inline std::string bankFileName(int part, int index)
{
    char name[8];
    patchSlotName(part, index <= kBackupSlot ? index : 0, name);
    return std::string(name) + (index <= kBackupSlot ? ".patch" : kSlotNamesExt);
}

// Copies the bank files of `part` from `srcDir` to `dstDir`. `Ops` provides
//   Presence stat(const std::string& path)   kAbsent only when the card found no such entry, kUnknown on any card error (never a failed lookup
//                                            taken for "not there": it would delete a saved file)
//   bool copyFile(const std::string& src, const std::string& dst)   the whole file replaces dst or dst stays as it is (false)
//   bool remove(const std::string& path)
// A source file that is not there but has an old version at <file>.bak (an interrupted replace) is copied from the .bak. Every file that
// exists in the source replaces the destination file only when it was copied completely.
// `prune` true (project open, the destination is the Workspace): a file the source does not have (the card said so for the file and for
// its .bak) is removed from the destination, with its .bak (a slot of the previous project never survives in the Workspace), but only after
// every copy worked and only when the destination's own state is known. Slot 0 is never removed (stock firmware knows only that file).
// `prune` false (project save, the destination is the project folder in Projects): nothing is ever removed there, a file the source lacks
// leaves the destination's file as it is. False: some file could not be copied or removed, or the card could not say, the caller reports
// it and nothing has been removed on a guess. The files that were not touched are as they were.
template <class Ops>
bool copyPartBank(Ops& ops, int part, const std::string& srcDir, const std::string& dstDir, bool prune)
{
    static_assert(kBankFiles <= 32, "one bit per file");
    uint32_t absent = 0;
    for (int i = 0; i < kBankFiles; i++)
    {
        const std::string file = bankFileName(part, i);
        const std::string src = srcDir + "\\" + file;
        const std::string* from = &src;
        std::string bak; // only set when the source file is gone: the copy then comes from <file>.bak
        Presence p = ops.stat(src);
        if (p == Presence::kAbsent)
        {
            bak = src + ".bak";
            const Presence b = ops.stat(bak);
            if (b == Presence::kPresent)
            {
                from = &bak;
                p = Presence::kPresent;
            }
            else if (b == Presence::kUnknown)
            {
                p = Presence::kUnknown;
            }
        }
        if (p == Presence::kUnknown)
        {
            return false;
        }
        if (p == Presence::kAbsent)
        {
            if (i > 0)
            {
                absent |= 1u << i;
            }
            continue;
        }
        if (!ops.copyFile(*from, dstDir + "\\" + file))
        {
            return false;
        }
    }
    for (int i = 1; prune && i < kBankFiles; i++)
    {
        if (!(absent & (1u << i)))
        {
            continue;
        }
        const std::string dst = dstDir + "\\" + bankFileName(part, i);
        // the .bak first: a power loss in between leaves a file that the next save prunes again, never a .bak that a reader brings back
        for (const std::string& path : { dst + ".bak", dst })
        {
            const Presence p = ops.stat(path);
            if (p == Presence::kUnknown || (p == Presence::kPresent && !ops.remove(path)))
            {
                return false;
            }
        }
    }
    return true;
}

// Project open, after the project's own files are in the Workspace: copies the patch bank, then loads the requested project.
// As in stock the result of the bank copy never decides the load, a patch error is not a reason to dispose of the copied song, patterns
// and samples (a new empty project would): the copy is tried once more (it replaces files whole, so it is safe to run again) and the
// project loads with the patch files the Workspace has. Only a Workspace that cannot be opened at all falls back to a new project.
// `settle` runs between the copy and the first load attempt. The audio engine restarts only in the normal load.
template <class Copy, class Settle, class Open, class CreateNew>
void openProjectAfterBankCopy(Copy copy, Settle settle, Open open, CreateNew createNew)
{
    if (!copy())
    {
        copy();
    }
    settle();
    if (!open())
    {
        createNew();
        open();
    }
}

} // namespace polysynth::open
