// poly_host: native host of the FF SYNTH EDITOR. Links the synth-open shim (engines, parameter metadata, .patch codec) from
// vendor/poly unchanged and exposes it as JSON lines on stdin / stdout (or one request on the command line).
//
// Requests (one JSON object per line, answered by one JSON object per line, {"ok":false,"error":...} on failure):
//   {"cmd":"engines"}
//   {"cmd":"meta","engine":"ACD"}                        params, sections, macros, curves, enum names, init patch
//   {"cmd":"describe","engine":..,"patch":{..},"macroValues":[..]}   value text, knob position, final (macro) text per param
//   {"cmd":"knob","engine":..,"param":i,"knob":0..1,"patch":{..}?}   knob position -> value + text (the firmware edit curve)
//   {"cmd":"knobs","engine":..,"patch":{..}?,"items":[{"param":i,"knob":0..1},..]}   many knob positions -> {"values":[..]} (the randomizer)
//   {"cmd":"load","path":"/x/y.patch"}                   .patch file -> patch JSON (through the firmware PatchStore)
//   {"cmd":"save","path":"/x/y.patch","patch":{..}}      patch JSON -> .patch file (atomic: temp file + rename)
//   {"cmd":"encode","patch":{..}}                        patch JSON -> {"hex":..} without touching the disk
//   {"cmd":"roundtrip","path":"/x/y.patch"}              load, save to memory, compare bytes (compatibility check)
//   {"cmd":"render","engine":..,"patch":{..},"macroValues":[..],"note":57,"velocity":100,"seconds":2,"hold":1,"out":"/tmp/x.wav"}
//
// Live mode (`poly_host --stream`): one long-lived Synth + Instrument that renders in real time. Control lines arrive on stdin:
//   {"cmd":"live.open","engine":..,"patch":{..},"macroValues":[..],"id":n}   (re)build the session, cuts sounding notes
//   {"cmd":"live.note","on":true|false,"note":60,"velocity":100,"id":n}
//   {"cmd":"live.param","param":i,"value":v | "knob":0..1,"id":n}           change one parameter while notes hold
//   {"cmd":"live.macro","macro":m,"value":0..100,"id":n}
//   {"cmd":"live.patch","patch":{..},"macroValues":[..],"id":n}             swap all values, voices keep sounding
//   {"cmd":"live.panic","id":n}
//   {"cmd":"live.voices","voices":1..8,"id":n}                              polyphony of the instrument (1 = mono legato / glide)
//   {"cmd":"live.cc","cc":0..127,"value":0..127,"id":n}                     64 = sustain pedal (host side), 102..107 = macros M1..M6,
//                                                                           120 / 123 = all notes off, the rest goes to the shim as is
//   {"cmd":"live.bend","value":-8192..8191,"id":n}                          pitch bend (the shim scales it to +-1 semitone)
// and one binary frame per 128 sample block (2.9 ms) leaves on stdout, paced by the wall clock:
//   u32 magic 0x314D4350 "PCM1" | u32 seq | u32 cmdId (id of the last control line applied) | u32 frames |
//   u32 voices (voices sounding, stolen ones excluded) | u32 held (of those, keys still down) | f32 mono[frames]
// (little endian). Control lines are applied between blocks, so a knob turn is heard in the next block. `--stream --manual`
// does not pace: it renders one block per {"cmd":"live.pull","blocks":n} line (tests).
//
// Patch JSON: {"engine":"ACD","values":[float|null,..],"macros":[{"name":..,"bipolar":..,"targets":[{"param":..,"amount":..}]}x8],
//              "extra":{"hasNames":bool,"hex":".."}}   (extra = the raw file fields the codec keeps for a byte exact save)
//
// Build: see scripts/build.ts (x86_64 under Rosetta: tiny::optional of the firmware headers has no arm64 support).
#include "json.h"
#include "open_load.h"
#include "open_patch.h"
#include "PolySynth/FileSystem.h"
#include "PolySynth/Instrument.h"
#include "PolySynth/MidiSource.h"
#include "PolySynth/PatchStore.h"
#include "PolySynth/Synth.h"
#include "PolySynth/sdk/InstrumentTypeRegistry.h"

#include <algorithm>
#include <cstdio>
#include <chrono>
#include <cmath>
#include <csignal>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <bitset>
#include <fstream>
#include <iostream>
#include <map>
#include <sstream>
#include <thread>
#ifndef __EMSCRIPTEN__
#include <poll.h>
#include <pthread.h>
#include <pthread/qos.h>
#include <mach/mach.h>
#include <mach/mach_time.h>
#include <mach/thread_policy.h>
#include <unistd.h>
#else
#include <emscripten/emscripten.h>
#include "modules.h"
#endif

namespace polysynth
{
std::unique_ptr<InstrumentType> createMidiOut();
// The firmware's run time engine list (open_cold.cpp, open::registerEngines: the engines of engine_list.h built here and the missing
// placeholder), registered exactly as core/synth/registry.cpp does under FEATURE_SYNTH_OPEN
void InstrumentTypeRegistry::registerInstrumentTypes(InstrumentTypeRegistry& r, const Synth::Allocator&)
{
    r.addInstrumentType(int(InstrumentTypeId::kMidiOut), createMidiOut());
    open::registerEngines(r);
}
} // namespace polysynth

using namespace polysynth;
using pj::Arr;
using pj::Json;
using pj::Obj;

namespace
{

// tracker-ff 1.2.0 .patch field 64 (synth automation): the editor neither shows nor renders it, so the codec reads every patch as an image
// without automation does (open_patchdata.h gModDecodeOff): the block stays raw in PatchData::extra, travels in the patch's "extra" hex and is
// written back in file order on save, a load then save is byte for byte. Set before any request (native and wasm host alike).
const bool kAutomationRaw = (polysynth::open::gModDecodeOff = true);

constexpr double kOutRate = 44100.0;         // WAV header rate
constexpr double kEngineRate = 44117.647;    // what the firmware engines really run at (MCLK/256)

// ---- in-memory file system behind the firmware PatchStore: keys "ENGINE/name.patch"
struct MemFS final : FileSystem
{
    struct Handle { std::string path; size_t pos; bool write; };
    std::map<std::string, std::vector<uint8_t>> files;
    std::vector<std::string> listed;

    std::vector<std::string_view> listFiles(const std::string& dir, std::function<bool(const std::string&)> match, tiny_optional<int>) override
    {
        listed.clear();
        const std::string pre = dir.empty() ? "" : dir + "/";
        for (auto& [k, v] : files)
        {
            if (k.compare(0, pre.size(), pre) == 0 && k.find('/', pre.size()) == std::string::npos && match(k.substr(pre.size())))
            {
                listed.push_back(k.substr(pre.size()));
            }
        }
        return std::vector<std::string_view>(listed.begin(), listed.end());
    }
    std::optional<FileHandle> open(const std::string& path, OpenOptions o) override
    {
        const bool w = o == OpenOptions::kWrite;
        if (!w && !files.count(path))
        {
            return std::nullopt;
        }
        if (w)
        {
            files[path].clear();
        }
        return new Handle{ path, 0, w };
    }
    void close(FileHandle h) override { delete static_cast<Handle*>(h); }
    bool write(FileHandle h, std::span<const uint8_t> d) override
    {
        auto& f = files[static_cast<Handle*>(h)->path];
        f.insert(f.end(), d.begin(), d.end());
        return true;
    }
    int32_t read(FileHandle h, std::span<uint8_t> b) override
    {
        auto* x = static_cast<Handle*>(h);
        auto& f = files[x->path];
        const size_t n = std::min(b.size(), f.size() - x->pos);
        std::copy_n(f.begin() + long(x->pos), n, b.begin());
        x->pos += n;
        return int32_t(n);
    }
    // The firmware's PatchStore writes <file>.tmp and replace()s the old file with it (open_cold.cpp writeRaw): the same calls as on the SD card
    Presence presence(const std::string& path) override { return files.count(path) ? Presence::kPresent : Presence::kAbsent; }
    bool replace(const std::string& from, const std::string& to) override
    {
        auto it = files.find(from);
        if (it == files.end())
        {
            return false;
        }
        auto data = std::move(it->second);
        files.erase(it);
        files[to] = std::move(data);
        return true;
    }
    bool remove(const std::string& path) override { return files.erase(path) > 0; }
    bool seek(FileHandle, int) override { return true; }
    void createFolder(const std::string&) override {}
};

struct KeySource final : MidiSource
{
    KeySource() : MidiSource(Type::kInternalKeyboard) {}
    std::weak_ptr<MidiEventCallback> cb;
    void subscribeMidiEvents(int, std::weak_ptr<MidiEventCallback> c) override { cb = c; }
    void send(MidiEvent::Type t, int ch, int a, int b)
    {
        MidiEvent e{};
        e.type = t;
        e.channel = uint8_t(ch);
        e.data.rawData.value1 = uint8_t(a);
        e.data.rawData.value2 = uint8_t(b);
        (*cb.lock())(e, 0);
    }
    void sendBend(int ch, int value)
    {
        MidiEvent e{};
        e.type = MidiEvent::Type::kPitchBendChange;
        e.channel = uint8_t(ch);
        e.data.pitchBendChange.value = int16_t(std::clamp(value, -8192, 8191));
        (*cb.lock())(e, 0);
    }
};

// What the editor adds to an engine of the firmware's list: the name the OpenTracker Synth page gives the OpenTracker 3.x engines (the picker
// name is DTYPE, the page says D-Type). Every engine in this table is shown in the "OpenTracker 3.x" group, the rest are OpenTracker 2.x (ACD FAT
// VAP WTFM PERC: clean-room DSP under the stock engine names), CHIP (Polyend's own open Chiptune code from tracker-ce), PHZ and Pluck in a group each. test/sync.test.ts checks this table against the firmware's engine_list.h.
struct Ot3Name
{
    int typeId;
    const char* display;
};
const Ot3Name kOt3Names[] = { { 0x80, "FM4" },    { 0x81, "JU6" },    { 0xA2, "D-Type" }, { 0x83, "CS-Type" }, { 0x84, "A-Type" },
                              { 0x85, "T-Type" }, { 0x86, "8-Type" }, { 0x87, "Hand-Type" }, { 0x88, "B-Type" }, { 0x89, "Arc-Type" } };

// The groups of the page besides "OpenTracker 3.x" and the "OpenTracker 2.x" default (key "polyend", kept for the API): CHIP is "Polyend open source" (key "polyend-oss"), PHZ has its own ("phz", a phase distortion engine, the Polyend
// Synth's) and Pluck ("plk", a Karplus-Strong engine, a release engine since tracker-ff 1.2.0). Pluck's page name is Pluck (its picker name is PLK).
// test/sync.test.ts checks the ids against the firmware's engine_list.h.
constexpr int kPhzTypeId = 0x82;
constexpr int kPluckTypeId = 0x8A;
constexpr int kChipTypeId = int(polysynth::InstrumentTypeId::kChiptuneSynth);
const char* groupOf(int typeId, bool ot3)
{
    return ot3 ? "ot3" : typeId == kPhzTypeId ? "phz" : typeId == kPluckTypeId ? "plk" : typeId == kChipTypeId ? "polyend-oss" : "polyend";
}
const char* displayOf(const char* name, int typeId, const char* ot3Display)
{
    return ot3Display ? ot3Display : typeId == kPluckTypeId ? "Pluck" : name;
}

const Ot3Name* ot3Name(int typeId)
{
    for (const auto& n : kOt3Names)
    {
        if (n.typeId == typeId)
        {
            return &n;
        }
    }
    return nullptr;
}

// OpenTracker 2.x engines and CHIP first (the firmware's list order: ACD FAT VAP WTFM PERC CHIP, then its own PHZ), then the OpenTracker 3.x engines in
// the order of kOt3Names
const std::vector<int>& engineTypes()
{
    static const std::vector<int> t = [] {
        std::vector<int> v;
#define SYNTH_ENGINE(NAME, STORED, TYPE_ID, ...) if (!ot3Name(int(TYPE_ID))) v.push_back(int(TYPE_ID));
#include "engine_list.h"
#undef SYNTH_ENGINE
        for (const auto& n : kOt3Names)
        {
            bool built = false;
#define SYNTH_ENGINE(NAME, STORED, TYPE_ID, ...) built = built || int(TYPE_ID) == n.typeId;
#include "engine_list.h"
#undef SYNTH_ENGINE
            if (built)
            {
                v.push_back(n.typeId);
            }
        }
        // an engine that arrives at run time (the wasm host, host/modules.cpp) is listed only once it is attached
        std::erase_if(v, [](int t) { const auto* d = open::engineDefForType(t); return !d || !d->engine; });
        return v;
    }();
    return t;
}

// Voices per instrument the editor honours. The firmware's cap is EngineDef::maxVoices (4, and 1 for PERC and T-Type, whose kit lives in the
// slot scratch: a second voice would only take it over). Above it (up to open::kEditorMaxVoices, 5 to 8) is an editor-only preview, strict
// ("Strict (match my Tracker)") holds the setting to the firmware's cap. A one voice engine is one voice either way.
int voicesFor(const open::EngineDef* def, int wanted, bool strict)
{
    const int cap = !def ? 1 : def->maxVoices <= 1 ? 1 : strict ? def->maxVoices : open::kEditorMaxVoices;
    return std::clamp(wanted, 1, cap);
}

const char* curveName(Patch::Metadata::Param::Curve c)
{
    switch (c)
    {
        case Patch::Metadata::Param::Curve::kLinear: return "linear";
        case Patch::Metadata::Param::Curve::kExponential: return "exp";
        case Patch::Metadata::Param::Curve::kExponentialSteep: return "expSteep";
        case Patch::Metadata::Param::Curve::kPower: return "power";
    }
    return "linear";
}

const char* fmtName(open::Fmt f)
{
    switch (f)
    {
        case open::Fmt::kPct: return "pct";
        case open::Fmt::kPctMax: return "pctMax";
        case open::Fmt::kHz: return "hz";
        case open::Fmt::kSec: return "sec";
        case open::Fmt::kLfoHz: return "lfoHz";
        case open::Fmt::kEnum: return "enum";
        case open::Fmt::kVal100: return "val100";
        case open::Fmt::kOnOff: return "onOff";
        case open::Fmt::kSemi: return "semi";
        case open::Fmt::kCents: return "cents";
        case open::Fmt::kInt: return "int";
        case open::Fmt::kRatio: return "ratio";
        case open::Fmt::kMs10: return "ms10";
        case open::Fmt::kDb: return "db";
        case open::Fmt::kPan: return "pan";
#ifdef SYNTH_ENGINE_PERC
        case open::Fmt::kNote: return "note";
        case open::Fmt::kBodyWave: return "bodyWave";
#endif
#ifdef SYNTH_ENGINE_PHZ
        case open::Fmt::kUnit: return "unit";
#endif
    }
    return "?";
}

const char* kindName(open::CurveKind c)
{
    switch (c)
    {
        case open::CurveKind::kLinear: return "linear";
        case open::CurveKind::kExp: return "exp";
        case open::CurveKind::kSteep: return "expSteep";
        case open::CurveKind::kPower: return "power";
    }
    return "?";
}

std::string hexOf(const uint8_t* p, size_t n)
{
    static const char* d = "0123456789abcdef";
    std::string s;
    s.reserve(n * 2);
    for (size_t i = 0; i < n; i++)
    {
        s += d[p[i] >> 4];
        s += d[p[i] & 15];
    }
    return s;
}

int hexVal(char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    throw std::runtime_error("bad hex digit");
}

std::vector<uint8_t> readFile(const std::string& path)
{
    std::ifstream f(path, std::ios::binary);
    if (!f)
    {
        throw std::runtime_error("cannot open " + path);
    }
    return std::vector<uint8_t>(std::istreambuf_iterator<char>(f), std::istreambuf_iterator<char>());
}

// Patches an older editor build saved with an editor-only engine id: CHIP as 0x10 (before the shim used Polyend's id 8) and D-Type as 0x82
// (between the OpenTracker 3.x engines and PHZ, which owns 0x82 and made D-Type move to 0xA2). The firmware's codec knows neither, so the
// engine id is rewritten in the decoded patch and the file is re-encoded by the codec. A 0x82 file is D-Type only when it has D-Type's parameter
// count (35, PHZ has 62). Returns the bytes to load, `note` says what was mapped (empty when nothing).
std::vector<uint8_t> migrateLegacyIds(const std::vector<uint8_t>& bytes, std::string& note)
{
    note.clear();
    if (bytes.size() > open::kPatchFileMax)
    {
        return bytes;
    }
    auto raw = std::make_unique<open::PatchData>();
    if (!open::decodePatch(bytes.data(), bytes.size(), *raw))
    {
        return bytes;
    }
    int to = 0;
    if (raw->engine == 0x10)
    {
        to = int(InstrumentTypeId::kChiptuneSynth);
        note = "CHIP patch written by an older editor build with engine id 0x10, loaded as Polyend's id 8";
    }
    else if (raw->engine == 0x82)
    {
        const auto* dt = open::engineDefForType(0xA2);
        const auto* phz = open::engineDefForType(0x82);
        if (dt && raw->nParams == dt->paramCount && !(phz && raw->nParams == phz->paramCount))
        {
            to = 0xA2;
            note = "D-Type patch written by an older editor build with engine id 0x82, loaded as 0xA2 (0x82 is PHZ)";
        }
    }
    if (!to)
    {
        return bytes;
    }
    raw->engine = to;
    std::vector<uint8_t> out(open::kPatchFileMax);
    const size_t n = open::encodePatch(*raw, out.data(), out.size());
    if (!n)
    {
        note.clear();
        return bytes;
    }
    out.resize(n);
    return out;
}

void writeFileAtomic(const std::string& path, const uint8_t* data, size_t n)
{
    namespace fs = std::filesystem;
    const fs::path p(path);
    if (p.has_parent_path())
    {
        fs::create_directories(p.parent_path());
    }
    const std::string tmp = path + ".tmp~";
    {
        std::ofstream f(tmp, std::ios::binary | std::ios::trunc);
        if (!f)
        {
            throw std::runtime_error("cannot write " + tmp);
        }
        f.write(reinterpret_cast<const char*>(data), std::streamsize(n));
        f.flush();
        if (!f)
        {
            fs::remove(tmp);
            throw std::runtime_error("write failed: " + tmp);
        }
    }
    std::error_code ec;
    fs::rename(tmp, p, ec);
    if (ec)
    {
        fs::remove(tmp);
        throw std::runtime_error("rename failed: " + ec.message());
    }
}

class Host
{
  public:
    Host()
    {
        synth = Synth::createSynth([](size_t) { return nullptr; });
        auto f = std::make_unique<MemFS>();
        memfs = f.get();
        synth->addFileSystem(Synth::FileSystemId::kPatches, std::move(f));
        store = synth->createPatchStore(Synth::FileSystemId::kPatches, true);
    }

    // One request -> one response object (text). Throws std::exception on bad requests.
    std::string handle(const Json& req)
    {
        const std::string cmd = req.str("cmd");
        if (cmd == "engines") return cmdEngines();
        if (cmd == "firmware") return cmdFirmware();
        if (cmd == "meta") return cmdMeta(req);
        if (cmd == "describe") return cmdDescribe(req);
        if (cmd == "knob") return cmdKnob(req);
        if (cmd == "knobs") return cmdKnobs(req);
        if (cmd == "load") return cmdLoad(req);
        if (cmd == "save") return cmdSave(req);
        if (cmd == "encode") return cmdEncode(req);
        if (cmd == "codec") return cmdCodec(req);
        if (cmd == "roundtrip") return cmdRoundtrip(req);
        if (cmd == "render") return cmdRender(req);
        if (cmd.rfind("live.", 0) == 0) return cmdLive(cmd, req);
        throw std::runtime_error("unknown cmd '" + cmd + "'");
    }

    // ---- live mode: renders one block of the session (silence when no session is open)
    static constexpr int kLiveBlock = 128;
    void liveBlock(float* out);

  private:
    struct Live
    {
        std::shared_ptr<Synth> synth;
        std::unique_ptr<KeySource> src;
        std::shared_ptr<Instrument> inst;
        std::shared_ptr<Instrument> arr[1];
        std::shared_ptr<open::OpenPatch> patch;
        const open::EngineDef* def = nullptr;
        int voices = 2;
        bool pedal = false;                // sustain pedal (CC64), applied here: the shim has no pedal handling (editor only, ignored when strict)
        bool strict = false;               // "Strict (match my Tracker)": voices held to the firmware cap, no sustain pedal
        std::bitset<128> deferred;         // keys released while the pedal was down
    } live;
    std::string cmdLive(const std::string& cmd, const Json& req);
    void releasePedal()
    {
        live.pedal = false;
        for (size_t n = 0; n < live.deferred.size(); n++)
        {
            if (live.deferred[n])
            {
                live.src->send(MidiEvent::Type::kNoteOff, 0, int(n), 0);
            }
        }
        live.deferred.reset();
    }
    std::shared_ptr<Synth> synth;
    MemFS* memfs = nullptr;
    std::unique_ptr<PatchStore> store;

    static std::string fail(const std::string& why) { return Obj().boolean("ok", false).str("error", why).done(); }

    const open::EngineDef* engineByName(const std::string& name) const
    {
        for (int t : engineTypes())
        {
            const auto* d = open::engineDefForType(t);
            if (d && name == d->name)
            {
                return d;
            }
        }
        throw std::runtime_error("unknown engine '" + name + "'");
    }
    std::shared_ptr<open::OpenPatch> newPatch(const open::EngineDef* d)
    {
        return std::static_pointer_cast<open::OpenPatch>(std::shared_ptr<Patch>(store->createPatch(d->typeId)));
    }

    // ---- patch JSON
    static std::string patchToJson(const open::PatchData& d, const open::EngineDef* def);
    static void jsonToData(const Json& j, open::PatchData& d);
    std::shared_ptr<open::OpenPatch> patchFromJson(const open::EngineDef* def, const Json* j);

    // ---- the firmware PatchStore (load / save) over the in-memory file system
    std::vector<uint8_t> encodeViaStore(const open::OpenPatch& p);
    bool loadViaStore(const std::vector<uint8_t>& bytes, open::OpenPatch& p);

    static void applyMacros(open::OpenPatch& p, const Json& req);
    std::string cmdEngines();
    std::string cmdFirmware();
    std::string cmdMeta(const Json& req);
    std::string cmdDescribe(const Json& req);
    std::string cmdKnob(const Json& req);
    std::string cmdKnobs(const Json& req);
    std::string cmdLoad(const Json& req);
    std::string cmdSave(const Json& req);
    std::string cmdEncode(const Json& req);
    std::string cmdCodec(const Json& req);
    std::string cmdRoundtrip(const Json& req);
    std::string cmdRender(const Json& req);
};

std::string Host::patchToJson(const open::PatchData& d, const open::EngineDef* def)
{
    Arr values;
    for (int i = 0; i < d.nParams; i++)
    {
        values.flt(d.values[i]); // NaN -> null
    }
    Arr macros;
    for (int m = 0; m < d.nMacros; m++)
    {
        const auto& src = d.macros[m];
        Arr targets;
        for (int t = 0; t < src.count; t++)
        {
            targets.raw(Obj().num("param", src.param[t]).flt("amount", src.amount[t]).done());
        }
        macros.raw(Obj().str("name", src.name).boolean("bipolar", src.bipolar).raw("targets", targets.done()).done());
    }
    const std::string extra = Obj().boolean("hasNames", d.extra.hasNames).str("hex", hexOf(d.extra.bytes, d.extra.len)).done();
    return Obj().str("engine", def->name).raw("values", values.done()).raw("macros", macros.done()).raw("extra", extra).done();
}

void Host::jsonToData(const Json& j, open::PatchData& d)
{
    if (const Json* v = j.get("values"); v && v->isArr())
    {
        d.nParams = int(std::min<size_t>(v->a.size(), open::kMaxParams));
        for (int i = 0; i < d.nParams; i++)
        {
            d.values[i] = v->a[size_t(i)].isNum() ? float(v->a[size_t(i)].n) : NAN;
        }
    }
    if (const Json* ms = j.get("macros"); ms && ms->isArr())
    {
        d.nMacros = int(std::min<size_t>(ms->a.size(), open::kPatchMacros));
        for (int m = 0; m < d.nMacros; m++)
        {
            const Json& src = ms->a[size_t(m)];
            auto& dst = d.macros[m];
            std::strncpy(dst.name, src.str("name").c_str(), open::kMacroNameMax);
            dst.bipolar = src.flag("bipolar", false);
            if (const Json* ts = src.get("targets"); ts && ts->isArr())
            {
                const int n = int(std::min<size_t>(ts->a.size(), open::kMacroTargets));
                for (int t = 0; t < n; t++)
                {
                    dst.param[t] = int16_t(ts->a[size_t(t)].num("param", 0));
                    dst.amount[t] = float(ts->a[size_t(t)].num("amount", 0));
                }
                dst.count = int8_t(n);
            }
        }
    }
    if (const Json* ex = j.get("extra"); ex && ex->isObj())
    {
        const std::string h = ex->str("hex");
        if (h.size() % 2 || h.size() / 2 > open::kRawMax)
        {
            throw std::runtime_error("extra.hex has a bad length");
        }
        d.extra.len = uint16_t(h.size() / 2);
        for (size_t i = 0; i < d.extra.len; i++)
        {
            d.extra.bytes[i] = uint8_t(hexVal(h[2 * i]) * 16 + hexVal(h[2 * i + 1]));
        }
        d.extra.hasNames = ex->flag("hasNames", false);
    }
}

std::shared_ptr<open::OpenPatch> Host::patchFromJson(const open::EngineDef* def, const Json* j)
{
    auto p = newPatch(def);
    if (j && j->isObj())
    {
        const std::string eng = j->str("engine", def->name);
        if (eng != def->name)
        {
            throw std::runtime_error("patch is for " + eng + ", not " + def->name);
        }
        auto d = std::make_unique<open::PatchData>();
        d->engine = open::engineIdForType(def->typeId);
        jsonToData(*j, *d);
        p->importData(*d);
    }
    return p;
}

std::vector<uint8_t> Host::encodeViaStore(const open::OpenPatch& p)
{
    const std::string key = std::string(p.getDef()->name) + "/_host.patch";
    if (!store->savePatch("_host", p))
    {
        throw std::runtime_error("PatchStore::savePatch failed");
    }
    auto bytes = memfs->files[key];
    memfs->files.erase(key);
    return bytes;
}

bool Host::loadViaStore(const std::vector<uint8_t>& bytes, open::OpenPatch& p)
{
    const std::string key = std::string(p.getDef()->name) + "/_host.patch";
    memfs->files[key] = bytes;
    const bool ok = store->loadPatch("_host", p, true);
    memfs->files.erase(key);
    return ok;
}

void Host::applyMacros(open::OpenPatch& p, const Json& req)
{
    const Json* mv = req.get("macroValues");
    if (mv && mv->isArr())
    {
        for (size_t m = 0; m < mv->a.size() && m < kUserMacroCount; m++)
        {
            if (mv->a[m].isNum())
            {
                p.setMacroValue(int(m), float(mv->a[m].n), std::nullopt);
            }
        }
    }
}

std::string Host::cmdEngines()
{
    Arr es;
    for (int t : engineTypes())
    {
        const auto* d = open::engineDefForType(t);
        const auto* ot = ot3Name(d->typeId);
        int stored = -1;
#define SYNTH_ENGINE(NAME, STORED, TYPE_ID, ...) if (int(TYPE_ID) == d->typeId) stored = STORED;
#include "engine_list.h"
#undef SYNTH_ENGINE
        // maxVoices is the firmware's cap (EngineDef::maxVoices), editorMaxVoices what the editor can render (open::kEditorMaxVoices)
        Obj e;
        e.str("name", d->name).str("display", displayOf(d->name, d->typeId, ot ? ot->display : nullptr)).str("group", groupOf(d->typeId, ot != nullptr))
          .num("typeId", d->typeId).num("engineId", open::engineIdForType(d->typeId)).num("stored", stored)
          .num("params", d->paramCount).num("sections", d->sectionCount).num("maxVoices", d->maxVoices)
          .num("editorMaxVoices", d->maxVoices <= 1 ? 1 : open::kEditorMaxVoices).num("volumeParam", d->volumeParam);
        es.raw(e.done());
    }
    return Obj().boolean("ok", true).raw("engines", es.done()).done();
}

// The firmware's own engine tables, straight from the EngineDef of every engine_list.h entry (not through Patch::Metadata, not through the
// editor's meta): what test/sync.test.ts compares the editor against. `stored` and `patchId` are the entry's STORED and PATCH_ENGINE columns.
std::string Host::cmdFirmware()
{
    Arr es;
#define SYNTH_ENGINE(NAME, STORED, TYPE_ID, FACTORY, DEF, PATCH_ENGINE, ...)                                                                \
    {                                                                                                                                      \
        const open::EngineDef& d = open::DEF;                                                                                              \
        Arr params;                                                                                                                        \
        for (int i = 0; i < d.paramCount; i++)                                                                                             \
        {                                                                                                                                  \
            const auto& p = d.params[i];                                                                                                   \
            Obj o;                                                                                                                         \
            o.num("id", i).str("name", p.name).flt("def", p.def).flt("min", p.min).flt("max", p.max).str("fmt", fmtName(p.fmt))             \
              .str("curve", kindName(p.curve));                                                                                            \
            if (p.fmt == open::Fmt::kEnum && p.enumNames)                                                                                  \
            {                                                                                                                              \
                Arr names;                                                                                                                 \
                for (int v = 0; v <= int(p.max); v++)                                                                                      \
                {                                                                                                                          \
                    names.str(p.enumNames[v]);                                                                                             \
                }                                                                                                                          \
                o.raw("names", names.done());                                                                                              \
            }                                                                                                                              \
            params.raw(o.done());                                                                                                          \
        }                                                                                                                                  \
        Arr sections;                                                                                                                      \
        for (int i = 0; i < d.sectionCount; i++)                                                                                           \
        {                                                                                                                                  \
            Arr ids;                                                                                                                       \
            for (int k = 0; k < d.sections[i].count; k++)                                                                                  \
            {                                                                                                                              \
                ids.num(d.sections[i].ids[k]);                                                                                             \
            }                                                                                                                              \
            sections.raw(Obj().str("name", d.sections[i].name).str("shortName", d.sections[i].shortName).raw("params", ids.done()).done()); \
        }                                                                                                                                  \
        Arr macros;                                                                                                                        \
        for (int i = 0; i < d.macroCount; i++)                                                                                             \
        {                                                                                                                                  \
            Arr targets;                                                                                                                   \
            for (int k = 0; k < d.macros[i].count; k++)                                                                                    \
            {                                                                                                                              \
                targets.raw(Obj().num("param", d.macros[i].targets[k].param).flt("amount", d.macros[i].targets[k].amount).done());          \
            }                                                                                                                              \
            macros.raw(Obj().str("name", d.macros[i].name).boolean("bipolar", d.macros[i].bipolar).raw("targets", targets.done()).done()); \
        }                                                                                                                                  \
        es.raw(Obj().str("name", #NAME).str("defName", d.name).num("stored", STORED).num("typeId", int(TYPE_ID)).num("patchId", PATCH_ENGINE) \
                 .num("maxVoices", d.maxVoices).num("volumeParam", d.volumeParam).boolean("slotFx", d.slotFx)                            \
                 .raw("params", params.done()).raw("sections", sections.done()).raw("macros", macros.done()).done());                      \
    }
#include "engine_list.h"
#undef SYNTH_ENGINE
    return Obj().boolean("ok", true).raw("engines", es.done()).done();
}

std::string Host::cmdMeta(const Json& req)
{
    const auto* def = engineByName(req.str("engine"));
    auto patch = newPatch(def);
    const auto& md = patch->getMetadata();
    std::vector<std::string> sectionOf(md.params.size());

    Arr sections;
    for (const auto& sec : md.layoutFlat.sections)
    {
        Arr ids;
        for (const auto& el : sec.elements)
        {
            if (el.type == Patch::Metadata::EditorLayout::EditorElement::Type::kParam && el.id >= 0 && el.id < int(md.params.size()))
            {
                ids.num(el.id);
                sectionOf[size_t(el.id)] = sec.name;
            }
        }
        sections.raw(Obj().str("name", sec.name).str("shortName", sec.shortName).raw("params", ids.done()).done());
    }
    Arr params;
    for (int i = 0; i < int(md.params.size()); i++)
    {
        const auto& p = md.params[size_t(i)];
        const auto& pd = def->params[i];
        Obj x;
        x.num("id", i).str("name", p.displayName).flt("min", float(p.minValue)).flt("max", float(p.maxValue));
        x.flt("def", p.defaultValue.value_or(0.0f)).str("curve", curveName(p.editCurve));
        x.str("macroOp", p.macroOperation == Patch::Metadata::Param::MacroOperation::kAdd ? "add" : "mult");
        x.str("section", sectionOf[size_t(i)]);
        if (p.midiCC.has_value())
        {
            x.num("midiCC", *p.midiCC);
        }
        const bool stepped = pd.fmt == open::Fmt::kEnum || pd.fmt == open::Fmt::kOnOff || pd.fmt == open::Fmt::kSemi ||
                             pd.fmt == open::Fmt::kInt || pd.fmt == open::Fmt::kRatio || pd.fmt == open::Fmt::kCents ||
                             pd.fmt == open::Fmt::kNote || pd.fmt == open::Fmt::kBodyWave; // PERC's note and body wave show whole steps
        x.boolean("stepped", stepped).boolean("isEnum", p.isEnum);
        if (p.isEnum || pd.fmt == open::Fmt::kEnum || pd.fmt == open::Fmt::kOnOff)
        {
            Arr names;
            for (int v = int(float(p.minValue)); v <= int(float(p.maxValue)); v++)
            {
                names.str(p.valueFormatter(*patch, float(v)));
            }
            x.raw("names", names.done());
        }
        params.raw(x.done());
    }
    Arr macros;
    for (size_t m = 0; m < md.macros.size(); m++)
    {
        const auto& mac = md.macros[m];
        macros.raw(Obj().str("name", mac.displayName).boolean("bipolar", mac.bipolar).boolean("system", mac.system)
                     .boolean("perVoice", mac.perVoice).flt("value", *patch->getMacroValue(int(m))).done());
    }
    open::PatchData d;
    patch->exportData(d);
    return Obj().boolean("ok", true).str("engine", def->name).num("typeId", def->typeId).num("engineId", open::engineIdForType(def->typeId))
      .num("maxVoices", def->maxVoices).num("volumeParam", def->volumeParam)
      .raw("sections", sections.done()).raw("params", params.done()).raw("macros", macros.done())
      .raw("init", patchToJson(d, def)).done();
}

std::string Host::cmdDescribe(const Json& req)
{
    const auto* def = engineByName(req.str("engine"));
    auto patch = patchFromJson(def, req.get("patch"));
    applyMacros(*patch, req);
    const auto& md = patch->getMetadata();
    Arr texts, knobs, finals, finalKnobs, finalTexts;
    for (int i = 0; i < patch->paramCount(); i++)
    {
        const auto& p = md.params[size_t(i)];
        const float v = *patch->getParamValue(i);
        const float fv = *patch->getParamFinalValue(i);
        texts.str(p.valueFormatter(*patch, v));
        knobs.flt(*patch->getParamValueEditMapped(i));
        finals.flt(fv);
        finalKnobs.flt(open::valueToCurve(def->params[i], fv));
        finalTexts.str(p.valueFormatter(*patch, fv));
    }
    return Obj().boolean("ok", true).raw("texts", texts.done()).raw("knobs", knobs.done()).raw("final", finals.done())
      .raw("finalKnobs", finalKnobs.done()).raw("finalTexts", finalTexts.done()).done();
}

std::string Host::cmdKnob(const Json& req)
{
    const auto* def = engineByName(req.str("engine"));
    auto patch = patchFromJson(def, req.get("patch"));
    const int id = int(req.num("param", -1));
    if (id < 0 || id >= patch->paramCount())
    {
        throw std::runtime_error("param out of range");
    }
    patch->setParamValueEditMapped(id, float(req.num("knob", 0)), Patch::ParamChangeSource::kKnob);
    const float v = *patch->getParamValue(id);
    return Obj().boolean("ok", true).flt("value", v).str("text", patch->getMetadata().params[size_t(id)].valueFormatter(*patch, v)).done();
}

// Many knob positions at once: each item is mapped through the firmware edit curve of its parameter, the same call as "knob"
std::string Host::cmdKnobs(const Json& req)
{
    const auto* def = engineByName(req.str("engine"));
    auto patch = patchFromJson(def, req.get("patch"));
    const Json* items = req.get("items");
    if (!items || !items->isArr() || items->a.size() > 4096)
    {
        throw std::runtime_error("items must be an array");
    }
    Arr values;
    for (const Json& it : items->a)
    {
        const int id = int(it.num("param", -1));
        if (id < 0 || id >= patch->paramCount())
        {
            throw std::runtime_error("param out of range");
        }
        patch->setParamValueEditMapped(id, float(it.num("knob", 0)), Patch::ParamChangeSource::kKnob);
        values.flt(*patch->getParamValue(id));
    }
    return Obj().boolean("ok", true).raw("values", values.done()).done();
}

// The engine of a .patch engine id, or -1. From tracker-ff 1.2.0 on the codec maps every plugin id it has no engine for (0x80 to 0x3FFF) to the
// firmware's "Missing" placeholder (kMissingTypeId: no parameters, no sound), so that a project keeps the values of a plugin that is not on the card.
// The editor has no card: a patch of an engine it has not got is refused, never opened as an empty Missing engine.
static int availableType(int engineId)
{
    const int type = open::typeForEngineId(engineId);
    return type == open::kMissingTypeId ? -1 : type;
}

static std::string notAvailable(int engineId)
{
    char id[32];
    std::snprintf(id, sizeof id, "0x%X (%d)", unsigned(engineId), engineId);
    return std::string("engine id ") + id + " is not available in this editor";
}

std::string Host::cmdLoad(const Json& req)
{
    std::string migrated;
    const auto bytes = migrateLegacyIds(readFile(req.str("path")), migrated);
    if (bytes.size() > open::kPatchFileMax)
    {
        return fail("file larger than " + std::to_string(open::kPatchFileMax) + " bytes");
    }
    auto raw = std::make_unique<open::PatchData>();
    if (!open::decodePatch(bytes.data(), bytes.size(), *raw))
    {
        return fail("not a valid .patch (decode failed)");
    }
    const int type = availableType(raw->engine);
    if (type < 0)
    {
        return fail(notAvailable(raw->engine));
    }
    const auto* def = open::engineDefForType(type);
    const std::string want = req.str("engine");
    if (!want.empty() && want != def->name)
    {
        return fail(std::string("file is a ") + def->name + " patch, not " + want);
    }
    auto patch = newPatch(def);
    if (!loadViaStore(bytes, *patch))
    {
        return fail("PatchStore::loadPatch refused the file");
    }
    // The firmware replaces a value outside [min,max] by the default. On the device min/max are half floats, here (x86)
    // plain floats, so a value like fp16(0.1) = 0.0999756 is "outside" only on this host: clamp those instead of losing them.
    Arr warnings;
    for (int i = 0; i < patch->paramCount(); i++)
    {
        const float a = i < raw->nParams ? raw->values[i] : NAN;
        if (!std::isfinite(a) || *patch->getParamValue(i) == a)
        {
            continue;
        }
        const auto& p = patch->getMetadata().params[size_t(i)];
        const float lo = float(p.minValue), hi = float(p.maxValue);
        const float tol = 1e-3f * std::max(std::fabs(lo), std::fabs(hi));
        char t[200];
        if (a >= lo - tol && a <= hi + tol)
        {
            patch->setParamValue(i, a, Patch::ParamChangeSource::kPatchAssign); // clamps to the bound
            snprintf(t, sizeof(t), "%s: file value %g is just outside %g..%g (half float rounding), clamped", p.displayName.c_str(), double(a), double(lo), double(hi));
        }
        else
        {
            snprintf(t, sizeof(t), "%s: file value %g is outside %g..%g, the firmware replaces it by the default", p.displayName.c_str(), double(a), double(lo), double(hi));
        }
        warnings.str(t);
    }
    if (!migrated.empty())
    {
        warnings.str(migrated);
    }
    open::PatchData d;
    patch->exportData(d);
    return Obj().boolean("ok", true).str("engine", def->name).num("size", double(bytes.size())).raw("patch", patchToJson(d, def))
      .raw("warnings", warnings.done()).done();
}

std::string Host::cmdEncode(const Json& req)
{
    const Json* pj = req.get("patch");
    const auto* def = engineByName(req.str("engine", pj ? pj->str("engine") : ""));
    auto patch = patchFromJson(def, pj);
    const auto bytes = encodeViaStore(*patch);
    return Obj().boolean("ok", true).num("size", double(bytes.size())).str("hex", hexOf(bytes.data(), bytes.size())).done();
}

// The firmware codec alone: the model's PatchData straight through open::encodePatch (open_patchio.cpp), no PatchStore, no file system. What
// "encode" and "save" (the PatchStore path) must write byte for byte.
std::string Host::cmdCodec(const Json& req)
{
    const Json* pj = req.get("patch");
    const auto* def = engineByName(req.str("engine", pj ? pj->str("engine") : ""));
    auto patch = patchFromJson(def, pj);
    open::PatchData d;
    patch->exportData(d);
    std::vector<uint8_t> buf(open::kPatchFileMax);
    const size_t n = open::encodePatch(d, buf.data(), buf.size());
    if (!n)
    {
        return fail("encodePatch failed");
    }
    return Obj().boolean("ok", true).num("size", double(n)).str("hex", hexOf(buf.data(), n)).done();
}

std::string Host::cmdSave(const Json& req)
{
    const Json* pj = req.get("patch");
    if (!pj)
    {
        throw std::runtime_error("patch missing");
    }
    const auto* def = engineByName(pj->str("engine", req.str("engine")));
    auto patch = patchFromJson(def, pj);
    const auto bytes = encodeViaStore(*patch);
    writeFileAtomic(req.str("path"), bytes.data(), bytes.size());
    return Obj().boolean("ok", true).num("size", double(bytes.size())).str("path", req.str("path")).done();
}

// Load a file with the firmware code, save it again to memory and compare the bytes.
// Always answers ok:true when the file could be read, the verdict is in loaded / identical.
std::string Host::cmdRoundtrip(const Json& req)
{
    std::string migrated;
    const auto bytes = migrateLegacyIds(readFile(req.str("path")), migrated);
    Obj o;
    o.boolean("ok", true).num("size", double(bytes.size()));
    if (!migrated.empty())
    {
        o.str("migrated", migrated);
    }
    auto refuse = [&](const std::string& why) { return o.boolean("loaded", false).boolean("identical", false).str("reason", why).done(); };

    if (bytes.size() > open::kPatchFileMax)
    {
        return refuse("file larger than " + std::to_string(open::kPatchFileMax) + " bytes (codec limit)");
    }
    auto raw = std::make_unique<open::PatchData>();
    if (!open::decodePatch(bytes.data(), bytes.size(), *raw))
    {
        return refuse("codec decode failed (truncated or malformed protobuf)");
    }
    if (availableType(raw->engine) < 0)
    {
        o.num("engineId", raw->engine);
        return refuse(notAvailable(raw->engine));
    }
    const auto* def = open::engineDefForType(availableType(raw->engine));
    o.str("engine", def->name);

    // the codec alone: decode -> encode
    std::vector<uint8_t> buf(open::kPatchFileMax);
    const size_t cn = open::encodePatch(*raw, buf.data(), buf.size());
    o.boolean("codecIdentical", cn == bytes.size() && std::equal(bytes.begin(), bytes.end(), buf.begin()));

    // the firmware path: PatchStore load -> save
    auto patch = newPatch(def);
    if (!loadViaStore(bytes, *patch))
    {
        return refuse("PatchStore::loadPatch refused the file");
    }
    const auto saved = encodeViaStore(*patch);
    const bool same = saved == bytes;
    o.boolean("loaded", true).boolean("identical", same).num("savedSize", double(saved.size()));
    Arr hints;
    if (!same)
    {
        size_t k = 0;
        while (k < saved.size() && k < bytes.size() && saved[k] == bytes[k])
        {
            k++;
        }
        o.num("firstDiff", double(k));
        // what the model changed between the raw file and the loaded patch
        open::PatchData now;
        patch->exportData(now);
        const auto& md = patch->getMetadata();
        for (int i = 0; i < patch->paramCount(); i++)
        {
            const float a = i < raw->nParams ? raw->values[i] : NAN;
            const float b = now.values[i];
            if (!(std::isnan(a) && std::isnan(b)) && !(a == b))
            {
                char t[240];
                snprintf(t, sizeof(t), "param-value: param %d '%s' file %g -> loaded %g (range %g..%g)", i, md.params[size_t(i)].displayName.c_str(), double(a),
                         double(b), double(float(md.params[size_t(i)].minValue)), double(float(md.params[size_t(i)].maxValue)));
                hints.str(t);
            }
        }
        for (int m = 0; m < raw->nMacros && m < now.nMacros; m++)
        {
            const auto &a = raw->macros[m], &b = now.macros[m];
            const std::string mn = "macro " + std::to_string(m) + " '" + a.name + "'";
            char t[240];
            if (std::strcmp(a.name, b.name) != 0)
            {
                hints.str("macro-name: " + mn + " -> '" + b.name + "'");
            }
            if (a.bipolar != b.bipolar)
            {
                hints.str("macro-bipolar: " + mn);
            }
            for (int s = 0; s < open::kMacroTargets; s++)
            {
                const bool used = a.param[s] != 0 || a.amount[s] != 0.0f;
                if (s >= a.count && used)
                {
                    snprintf(t, sizeof(t), "target-beyond-count: %s slot %d (count %d) param %d amount %g dropped", mn.c_str(), s, a.count, a.param[s], double(a.amount[s]));
                    hints.str(t);
                }
                else if (s < a.count && a.param[s] < 0)
                {
                    snprintf(t, sizeof(t), "unassigned-target: %s slot %d has no param (-1) but amount %g, dropped", mn.c_str(), s, double(a.amount[s]));
                    hints.str(t);
                }
                else if (s < a.count && a.param[s] >= patch->paramCount())
                {
                    snprintf(t, sizeof(t), "target-param-out-of-range: %s slot %d param %d >= %d params, dropped", mn.c_str(), s, a.param[s], patch->paramCount());
                    hints.str(t);
                }
                else if (s < a.count && std::fabs(a.amount[s]) > 2.0f)
                {
                    snprintf(t, sizeof(t), "amount-clamped: %s slot %d amount %g -> +-2", mn.c_str(), s, double(a.amount[s]));
                    hints.str(t);
                }
            }
            if (a.count != b.count && hints.done().find("macro " + std::to_string(m) + " ") == std::string::npos)
            {
                hints.str("other-macro-count: " + mn + " count " + std::to_string(a.count) + " -> " + std::to_string(b.count));
            }
        }
        if (raw->nParams != now.nParams)
        {
            hints.str("param-count: file has " + std::to_string(raw->nParams) + ", engine has " + std::to_string(now.nParams));
        }
    }
    return o.raw("hints", hints.done()).done();
}

// ---- WAV
void putLE(std::vector<uint8_t>& v, uint32_t x, int bytes)
{
    for (int i = 0; i < bytes; i++)
    {
        v.push_back(uint8_t((x >> (8 * i)) & 0xFF));
    }
}

std::vector<uint8_t> makeWav(const std::vector<float>& s, bool f32)
{
    std::vector<uint8_t> w;
    const uint32_t bps = f32 ? 4 : 2, dataBytes = uint32_t(s.size()) * bps;
    w.insert(w.end(), { 'R', 'I', 'F', 'F' });
    putLE(w, 36 + dataBytes, 4);
    w.insert(w.end(), { 'W', 'A', 'V', 'E', 'f', 'm', 't', ' ' });
    putLE(w, 16, 4);
    putLE(w, f32 ? 3 : 1, 2);
    putLE(w, 1, 2);
    putLE(w, uint32_t(kOutRate), 4);
    putLE(w, uint32_t(kOutRate) * bps, 4);
    putLE(w, bps, 2);
    putLE(w, bps * 8, 2);
    w.insert(w.end(), { 'd', 'a', 't', 'a' });
    putLE(w, dataBytes, 4);
    for (float x : s)
    {
        if (f32)
        {
            uint32_t u;
            std::memcpy(&u, &x, 4);
            putLE(w, u, 4);
        }
        else
        {
            const int q = int(std::lround(std::clamp(x, -1.0f, 1.0f) * 32767.0f));
            putLE(w, uint32_t(uint16_t(int16_t(q))), 2);
        }
    }
    return w;
}

std::string Host::cmdRender(const Json& req)
{
    const Json* pj = req.get("patch");
    const auto* def = engineByName(req.str("engine", pj ? pj->str("engine") : ""));
    auto patch = patchFromJson(def, pj);
    applyMacros(*patch, req);
    const int note = std::clamp(int(req.num("note", 57)), 0, 127);
    const int vel = std::clamp(int(req.num("velocity", 100)), 1, 127);
    const double seconds = std::clamp(req.num("seconds", 2.0), 0.05, 30.0);
    const double hold = std::clamp(req.num("hold", std::min(seconds, 1.0)), 0.0, seconds);
    const bool f32 = req.flag("float", false);
    const bool strict = req.flag("strict", false);
    open::setHeldNotes(!strict);
    const int voices = voicesFor(def, int(req.num("voices", 2)), strict);

    // A fresh Synth per render: no voices, envelopes or glide left from the last note
    auto rs = Synth::createSynth([](size_t) { return nullptr; });
    open::setOffline(true);
    KeySource src;
    auto inst = rs->createInstrument(0);
    inst->assignPatch(patch);
    inst->connect(src);
    inst->setVoiceCount(voices);
    inst->setMidiChannel(0);
    std::shared_ptr<Instrument> arr[1] = { inst };
    rs->setup(std::span<std::shared_ptr<Instrument>>(arr, 1), {}, nullptr, [] { return tiny::optional<float>(120.0f); });

    constexpr int kBlock = 128;
    const size_t frames = size_t(std::llround(seconds * kEngineRate));
    const size_t blocks = (frames + kBlock - 1) / kBlock;
    const size_t offBlock = size_t(std::llround(hold * kEngineRate / kBlock));
    std::array<float, kBlock> L{}, R{}, A1{}, A2{};
    std::array<AudioBufferRef, 2> aux{ AudioBufferRef(A1), AudioBufferRef(A2) };
    std::vector<float> pcm;
    pcm.reserve(blocks * kBlock);
    bool finite = true;
    double sum2 = 0;
    float peak = 0;
    size_t clipped = 0;
    for (size_t b = 0; b < blocks; b++)
    {
        if (b == 0)
        {
            src.send(MidiEvent::Type::kNoteOn, 0, note, vel);
        }
        if (b == offBlock)
        {
            src.send(MidiEvent::Type::kNoteOff, 0, note, 0);
        }
        rs->renderAudioBuffer({ AudioBufferRef(L), AudioBufferRef(R) }, std::span<AudioBufferRef>(aux), 0);
        for (float v : L)
        {
            if (!std::isfinite(v))
            {
                finite = false;
                pcm.push_back(0.0f);
                continue;
            }
            peak = std::max(peak, std::fabs(v));
            clipped += std::fabs(v) > 1.0f;
            sum2 += double(v) * double(v);
            pcm.push_back(v);
        }
    }
    pcm.resize(frames);
    inst.reset();
    rs.reset();
    open::setOffline(false);

    const double rms = pcm.empty() ? 0.0 : std::sqrt(sum2 / double(pcm.size()));
    Obj o;
    o.boolean("ok", true).num("frames", double(pcm.size())).num("sampleRate", kOutRate).num("engineRate", kEngineRate);
    o.boolean("finite", finite).flt("peak", peak).flt("rms", float(rms)).num("clipped", double(clipped));
    o.boolean("nonSilent", finite && peak > 1e-4f);
    const std::string path = req.str("out");
    if (!path.empty())
    {
        const auto wav = makeWav(pcm, f32);
        writeFileAtomic(path, wav.data(), wav.size());
        o.str("out", path).num("bytes", double(wav.size()));
    }
    return o.done();
}

// ---- live mode
std::string Host::cmdLive(const std::string& cmd, const Json& req)
{
    auto closeLive = [&]
    {
        live.arr[0].reset();
        live.inst.reset();
        live.synth.reset();
        live.src.reset();
        live.patch.reset();
        live.def = nullptr;
    };
    if (cmd == "live.open")
    {
        const Json* pj = req.get("patch");
        const auto* def = engineByName(req.str("engine", pj ? pj->str("engine") : ""));
        auto patch = patchFromJson(def, pj);
        applyMacros(*patch, req);
        closeLive();
        live.synth = Synth::createSynth([](size_t) { return nullptr; });
        open::setOffline(true);
        live.src = std::make_unique<KeySource>();
        live.inst = live.synth->createInstrument(0);
        live.inst->assignPatch(patch);
        live.inst->connect(*live.src);
        live.strict = req.flag("strict", false);
        open::setHeldNotes(!live.strict);
        live.voices = voicesFor(def, int(req.num("voices", 2)), live.strict);
        live.pedal = false;
        live.deferred.reset();
        live.inst->setVoiceCount(live.voices);
        live.inst->setMidiChannel(0);
        live.arr[0] = live.inst;
        live.synth->setup(std::span<std::shared_ptr<Instrument>>(live.arr, 1), {}, nullptr, [] { return tiny::optional<float>(120.0f); });
        open::setVoiceBudget(open::kMaxVoiceBudget); // the pool default is 4, the editor lets 8 voices sound
        live.patch = patch;
        live.def = def;
        return Obj().boolean("ok", true).str("engine", def->name).num("params", patch->paramCount()).done();
    }
    if (cmd == "live.close")
    {
        closeLive();
        return Obj().boolean("ok", true).done();
    }
    if (!live.synth)
    {
        throw std::runtime_error("no live session, send live.open first");
    }
    if (cmd == "live.note")
    {
        const int note = std::clamp(int(req.num("note", 60)), 0, 127);
        const int vel = std::clamp(int(req.num("velocity", 100)), 0, 127);
        if (req.flag("on", true) && vel > 0)
        {
            if (live.deferred[size_t(note)])
            {
                live.deferred.reset(size_t(note)); // struck again while the pedal holds it: the held voice is let go, the new one owns the key
                live.src->send(MidiEvent::Type::kNoteOff, 0, note, 0);
            }
            live.src->send(MidiEvent::Type::kNoteOn, 0, note, vel);
        }
        else if (live.pedal)
        {
            live.deferred.set(size_t(note)); // the pedal holds it
        }
        else
        {
            live.src->send(MidiEvent::Type::kNoteOff, 0, note, 0);
        }
    }
    else if (cmd == "live.voices")
    {
        live.strict = req.flag("strict", live.strict);
        open::setHeldNotes(!live.strict);
        live.voices = voicesFor(live.def, int(req.num("voices", 2)), live.strict);
        live.inst->setVoiceCount(live.voices);
        if (live.strict && live.pedal) // strict has no sustain pedal: let go of what the pedal held
        {
            releasePedal();
        }
    }
    else if (cmd == "live.cc")
    {
        const int cc = std::clamp(int(req.num("cc", 0)), 0, 127);
        const int value = std::clamp(int(req.num("value", 0)), 0, 127);
        if (cc == 64)
        {
            live.pedal = !live.strict && value >= 64; // the sustain pedal is editor only: strict mode ignores it
            if (!live.pedal)
            {
                releasePedal();
            }
        }
        else
        {
            if (cc == 120 || cc == MidiEvent::Data::ControlChange::kAllNotesOffCC)
            {
                live.deferred.reset();
            }
            live.src->send(MidiEvent::Type::kControlChange, 0, cc, value); // 102..107 reach the macros inside the shim
        }
    }
    else if (cmd == "live.bend")
    {
        live.src->sendBend(0, int(std::lround(req.num("value", 0))));
    }
    else if (cmd == "live.param")
    {
        const int id = int(req.num("param", -1));
        if (id < 0 || id >= live.patch->paramCount())
        {
            throw std::runtime_error("param out of range");
        }
        if (req.get("knob"))
        {
            live.patch->setParamValueEditMapped(id, float(req.num("knob", 0)), Patch::ParamChangeSource::kKnob);
        }
        else
        {
            live.patch->setParamValue(id, float(req.num("value", 0)), Patch::ParamChangeSource::kKnob);
        }
    }
    else if (cmd == "live.macro")
    {
        const int m = int(req.num("macro", -1));
        if (m < 0 || m >= int(kUserMacroCount))
        {
            throw std::runtime_error("macro out of range");
        }
        live.patch->setMacroValue(m, float(req.num("value", 0)), std::nullopt);
    }
    else if (cmd == "live.patch")
    {
        const Json* pj = req.get("patch");
        if (!pj || !pj->isObj() || pj->str("engine", live.def->name) != live.def->name)
        {
            throw std::runtime_error(std::string("patch missing or not a ") + live.def->name + " patch");
        }
        auto d = std::make_unique<open::PatchData>();
        d->engine = open::engineIdForType(live.def->typeId);
        jsonToData(*pj, *d);
        live.patch->importData(*d);
        applyMacros(*live.patch, req);
    }
    else if (cmd == "live.panic")
    {
        live.deferred.reset();
        live.pedal = false;
        live.src->send(MidiEvent::Type::kControlChange, 0, MidiEvent::Data::ControlChange::kAllNotesOffCC, 0);
    }
    else
    {
        throw std::runtime_error("unknown cmd '" + cmd + "'");
    }
    return Obj().boolean("ok", true).done();
}

void Host::liveBlock(float* out)
{
    if (!live.synth)
    {
        std::fill(out, out + kLiveBlock, 0.0f);
        return;
    }
    std::array<float, kLiveBlock> L{}, R{}, A1{}, A2{};
    std::array<AudioBufferRef, 2> aux{ AudioBufferRef(A1), AudioBufferRef(A2) };
    live.synth->renderAudioBuffer({ AudioBufferRef(L), AudioBufferRef(R) }, std::span<AudioBufferRef>(aux), 0);
    for (int i = 0; i < kLiveBlock; i++)
    {
        out[i] = std::isfinite(L[size_t(i)]) ? L[size_t(i)] : 0.0f;
    }
}

// Turn the command line into a request: `engines`, `meta ACD`, `load f.patch`, `roundtrip f.patch`,
// `render ACD out.wav [note] [seconds] [f.patch]`, or a JSON object as it is.
std::string requestFromArgs(int argc, char** argv)
{
    const std::string a1 = argv[1];
    auto arg = [&](int i, const char* def = "") { return i < argc ? std::string(argv[i]) : std::string(def); };
    if (a1[0] == '{')
    {
        return a1;
    }
    if (a1 == "engines")
    {
        return Obj().str("cmd", "engines").done();
    }
    if (a1 == "meta")
    {
        return Obj().str("cmd", "meta").str("engine", arg(2)).done();
    }
    if (a1 == "load" || a1 == "roundtrip")
    {
        return Obj().str("cmd", a1).str("path", arg(2)).done();
    }
    if (a1 == "render")
    {
        Obj o;
        o.str("cmd", "render").str("engine", arg(2)).str("out", arg(3, "render.wav")).num("note", std::atof(arg(4, "57").c_str()))
          .num("seconds", std::atof(arg(5, "2").c_str()));
        return o.done();
    }
    throw std::runtime_error("usage: poly_host [--serve] | engines | meta ENG | load FILE | roundtrip FILE | render ENG out.wav [note] [sec] | '<json>'");
}

// One request line -> one answer line. The answer carries the request "id" when there is one.
std::string answerLine(Host& host, const std::string& line)
{
    try
    {
        const Json req = pj::Parser::parse(line);
        std::string res = host.handle(req);
        // echo a request id so a client can match answers
        if (const Json* id = req.get("id"); id && !res.empty() && res[0] == '{')
        {
            std::string idText;
            if (id->isNum())
            {
                pj::putNum(idText, id->n);
            }
            else if (id->isStr())
            {
                pj::putStr(idText, id->s);
            }
            if (!idText.empty())
            {
                res = "{\"id\":" + idText + (res.size() > 2 ? "," : "") + res.substr(1);
            }
        }
        return res;
    }
    catch (const std::exception& e)
    {
        return Obj().boolean("ok", false).str("error", e.what()).done();
    }
}

#ifndef __EMSCRIPTEN__
bool writeAll(int fd, const void* data, size_t n)
{
    const char* p = static_cast<const char*>(data);
    while (n > 0)
    {
        const ssize_t w = write(fd, p, n);
        if (w < 0 && errno == EINTR)
        {
            continue;
        }
        if (w <= 0)
        {
            return false;
        }
        p += w;
        n -= size_t(w);
    }
    return true;
}

// `--stream`: real time blocks on stdout, control lines on stdin (see the file header). manual = one block per live.pull.
int streamMain(Host& host, bool manual)
{
    signal(SIGPIPE, SIG_IGN);
    // A background tool process gets its timers coalesced by the OS (wake-ups 10 to 40 ms late): ask for the audio class
    pthread_set_qos_class_self_np(QOS_CLASS_USER_INTERACTIVE, 0);
    // ... and a real time slot of 1 ms every block, like a CoreAudio thread, so a loaded machine still wakes us on time
    {
        mach_timebase_info_data_t tb;
        mach_timebase_info(&tb);
        const double nsToAbs = double(tb.denom) / double(tb.numer);
        thread_time_constraint_policy_data_t pol;
        pol.period = uint32_t(Host::kLiveBlock / kEngineRate * 1e9 * nsToAbs);
        pol.computation = uint32_t(1e6 * nsToAbs);
        pol.constraint = pol.period;
        pol.preemptible = 1;
        thread_policy_set(mach_thread_self(), THREAD_TIME_CONSTRAINT_POLICY, reinterpret_cast<thread_policy_t>(&pol), THREAD_TIME_CONSTRAINT_POLICY_COUNT);
    }
    using Clock = std::chrono::steady_clock;
    uint32_t seq = 0, lastId = 0;
    std::string inbuf;
    bool alive = true;

    auto emit = [&]
    {
        struct
        {
            uint32_t magic, seq, cmdId, frames, voices, held;
            float pcm[Host::kLiveBlock];
        } f;
        f.magic = 0x314D4350u;
        f.seq = seq++;
        f.cmdId = lastId;
        f.frames = Host::kLiveBlock;
        host.liveBlock(f.pcm);
        f.voices = uint32_t(open::voicesSounding());
        f.held = uint32_t(open::voicesHeld());
        if (!writeAll(1, &f, sizeof(f)))
        {
            alive = false;
        }
    };
    auto onLine = [&](const std::string& line)
    {
        if (line.empty())
        {
            return;
        }
        bool pull = false;
        int blocks = 0;
        try
        {
            const Json req = pj::Parser::parse(line);
            pull = req.str("cmd") == "live.pull";
            blocks = int(std::clamp(req.num("blocks", 1), 0.0, 100000.0));
            if (const Json* id = req.get("id"); id && id->isNum())
            {
                lastId = uint32_t(id->n);
            }
        }
        catch (const std::exception&)
        {
        }
        if (pull)
        {
            for (int i = 0; i < blocks && alive; i++)
            {
                emit();
            }
            return;
        }
        const std::string res = answerLine(host, line);
        if (res.rfind("{\"ok\":false", 0) == 0 || res.find("\"ok\":false") != std::string::npos)
        {
            fprintf(stderr, "poly_host --stream: %s\n", res.c_str()); // the client sees it as a missing effect, the log says why
        }
    };
    auto feed = [&](const char* data, size_t n)
    {
        inbuf.append(data, n);
        size_t nl;
        while ((nl = inbuf.find('\n')) != std::string::npos)
        {
            onLine(inbuf.substr(0, nl));
            inbuf.erase(0, nl + 1);
        }
    };

    if (manual)
    {
        char buf[4096];
        ssize_t n;
        while (alive && (n = read(0, buf, sizeof(buf))) > 0)
        {
            feed(buf, size_t(n));
        }
        return 0;
    }
    const auto blockDur = std::chrono::nanoseconds(int64_t(Host::kLiveBlock / kEngineRate * 1e9));
    const bool lateStats = std::getenv("POLY_STREAM_STATS") != nullptr; // diagnostics: how late the pacing wakes up
    double lateMax = 0, lateSum = 0;
    int lateN = 0;
    auto next = Clock::now();
    while (alive)
    {
        for (;;)
        {
            const auto now = Clock::now();
            if (now >= next)
            {
                break;
            }
            const auto rem = std::chrono::duration_cast<std::chrono::microseconds>(next - now).count();
            pollfd pfd{ 0, POLLIN, 0 };
            const int ms = rem > 1500 ? int((rem - 1000) / 1000) : 0;
            const int r = poll(&pfd, 1, ms);
            if (r > 0)
            {
                char buf[4096];
                const ssize_t n = read(0, buf, sizeof(buf));
                if (n <= 0)
                {
                    return 0; // the server closed the pipe
                }
                feed(buf, size_t(n));
            }
            else if (ms == 0)
            {
                std::this_thread::sleep_for(std::chrono::microseconds(std::min<long long>(rem, 150)));
            }
        }
        if (lateStats)
        {
            const double late = std::chrono::duration<double, std::milli>(Clock::now() - next).count();
            lateMax = std::max(lateMax, late);
            lateSum += late;
            if (++lateN == 1000)
            {
                fprintf(stderr, "poly_host --stream: block wake-up lateness over 1000 blocks: mean %.2f ms, max %.2f ms\n", lateSum / 1000, lateMax);
                lateN = 0;
                lateSum = lateMax = 0;
            }
        }
        emit();
        next += blockDur;
        if (Clock::now() > next + std::chrono::milliseconds(50))
        {
            next = Clock::now(); // fell behind (machine asleep, debugger): do not burst to catch up
        }
    }
    return 0;
}
#endif // !__EMSCRIPTEN__

} // namespace

#ifndef __EMSCRIPTEN__
int main(int argc, char** argv)
{
    Host host;
    if (argc > 1 && std::strcmp(argv[1], "--stream") == 0)
    {
        return streamMain(host, argc > 2 && std::strcmp(argv[2], "--manual") == 0);
    }
    auto answer = [&](const std::string& line) { return answerLine(host, line); };

    if (argc > 1 && std::strcmp(argv[1], "--serve") != 0)
    {
        std::string req;
        try
        {
            req = requestFromArgs(argc, argv);
        }
        catch (const std::exception& e)
        {
            fprintf(stderr, "%s\n", e.what());
            return 2;
        }
        const std::string res = answer(req);
        puts(res.c_str());
        return res.rfind("{\"ok\":true", 0) == 0 ? 0 : 1;
    }
    std::string line;
    while (std::getline(std::cin, line))
    {
        if (line.empty())
        {
            continue;
        }
        const std::string res = answer(line);
        fwrite(res.data(), 1, res.size(), stdout);
        fputc('\n', stdout);
        fflush(stdout);
    }
    return 0;
}
#else // __EMSCRIPTEN__: the wasm host (scripts/build-wasm.ts). No process and no stream loop: the page calls these, a block at a time.

static Host& theHost()
{
    static Host h;
    return h;
}

extern "C"
{
// One JSON request line -> one JSON answer (valid until the next call). The first request freezes the engine list: modules attach before.
EMSCRIPTEN_KEEPALIVE const char* ph_request(const char* line)
{
    static std::string r;
    ffmFreezeList();
    r = answerLine(theHost(), line);
    return r.c_str();
}

// One 128 frame live block, stereo: the engine (mono, as the stream path), then the master section of the device (delay, reverb, Mixer stage, inserts). Returns L, R follows.
EMSCRIPTEN_KEEPALIVE float* ph_block()
{
    static float buf[2][Host::kLiveBlock];
    theHost().liveBlock(buf[0]);
    std::copy(buf[0], buf[0] + Host::kLiveBlock, buf[1]);
    ffmEngineChain(buf[0], buf[1]);
    return buf[0];
}

EMSCRIPTEN_KEEPALIVE int ph_voices() { return int(open::voicesSounding()); }
EMSCRIPTEN_KEEPALIVE int ph_held() { return int(open::voicesHeld()); }
}
#endif
