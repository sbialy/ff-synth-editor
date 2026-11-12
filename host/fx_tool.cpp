// Native proof tool for host/fx.cpp: reads a raw float32 mono file, runs it through the firmware's delay, reverb and mixers (the graph of fx.h) 128 frames at a
// time and writes the int16 bus as interleaved left, right. Built by scripts/build-fx.ts for arm64 with -ffp-contract=off (the 1.2.0 images are AUTO-F),
// compared by test/fx.test.ts with the same graph compiled to wasm, and with the Cortex-M4 build of the same sources run in an emulator (test/fx-m4).
//   fx_tool <in.f32> <out.s16> [key=value ...]
// keys: delayFeedback delayTime delayParams delayFilter reverbSize reverbDamp reverbPredelay reverbDiffusion delayVolume reverbVolume delayMute reverbMute
//       delaySend reverbSend tempo mixer limiterOn limiterAttack limiterRelease limiterThreshold limiterMode, tail=<blocks> (silent blocks to append after the input, default 0)
// A line "@<block> key=value ..." on stdin changes values before that block, as the page does while playing.
#include "fx.h"
#include <cmath>
#include "mtStructs.h" // expf is fx_expf in this build

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <map>
#include <sstream>
#include <string>
#include <vector>

static bool set(fx::Params& p, const std::string& k, double v)
{
    if (k == "delayFeedback") p.delayFeedback = uint8_t(v);
    else if (k == "delayTime") p.delayTime = uint16_t(v);
    else if (k == "delayParams") p.delayParams = uint8_t(v);
    else if (k == "delayFilter") p.delayFilter = uint16_t(v);
    else if (k == "reverbSize") p.reverbSize = float(v);
    else if (k == "reverbDamp") p.reverbDamp = float(v);
    else if (k == "reverbPredelay") p.reverbPredelay = float(v);
    else if (k == "reverbDiffusion") p.reverbDiffusion = float(v);
    else if (k == "delayVolume") p.delayVolume = uint8_t(v);
    else if (k == "reverbVolume") p.reverbVolume = uint8_t(v);
    else if (k == "delayMute") p.delayMute = v != 0;
    else if (k == "reverbMute") p.reverbMute = v != 0;
    else if (k == "delaySend") p.delaySend = float(v);
    else if (k == "reverbSend") p.reverbSend = float(v);
    else if (k == "tempo") p.tempo = float(v);
    else if (k == "mixer") p.mixer = int(v);
    else if (k == "limiterOn") p.limiterOn = v != 0;
    else if (k == "limiterAttack") p.limiterAttack = uint16_t(v);
    else if (k == "limiterRelease") p.limiterRelease = float(v);
    else if (k == "limiterThreshold") p.limiterThreshold = uint16_t(v);
    else if (k == "limiterMode") p.limiterMode = uint8_t(v);
    else return false;
    return true;
}

int main(int argc, char** argv)
{
    if (argc < 3)
    {
        fprintf(stderr, "usage: fx_tool in.f32 out.s16 [key=value ...]\n");
        return 2;
    }
    if (std::string(argv[1]) == "--expf")
    {   // fx_expf over fx::expfGrid, as float32 (the Cortex-M4F build writes newlib's over the same grid)
        std::vector<float> o(fx::kExpfGrid);
        for (int i = 0; i < fx::kExpfGrid; i++) o[i] = expf(fx::expfGrid(i));
        FILE* f = fopen(argv[2], "wb");
        if (!f) return 1;
        fwrite(o.data(), 4, o.size(), f);
        fclose(f);
        return 0;
    }
    fx::Params p;
    long tail = 0;
    for (int i = 3; i < argc; i++)
    {
        std::string a = argv[i];
        auto eq = a.find('=');
        if (eq == std::string::npos) return 2;
        const std::string k = a.substr(0, eq);
        const double v = atof(a.c_str() + eq + 1);
        if (k == "tail") tail = long(v);
        else if (!set(p, k, v))
        {
            fprintf(stderr, "unknown key %s\n", k.c_str());
            return 2;
        }
    }
    std::vector<float> in;
    {
        FILE* f = fopen(argv[1], "rb");
        if (!f) return 1;
        fseek(f, 0, SEEK_END);
        in.resize(ftell(f) / 4);
        fseek(f, 0, SEEK_SET);
        if (fread(in.data(), 4, in.size(), f) != in.size()) return 1;
        fclose(f);
    }
    const size_t blocks = (in.size() + fx::kBlock - 1) / fx::kBlock + size_t(tail);
    in.resize(blocks * fx::kBlock, 0.0f);
    std::map<size_t, std::vector<std::pair<std::string, double>>> changes;
    std::string line;
    while (std::getline(std::cin, line))
    {
        std::istringstream is(line);
        std::string tok;
        if (!(is >> tok) || tok[0] != '@') continue;
        const size_t at = size_t(atol(tok.c_str() + 1));
        while (is >> tok)
        {
            auto eq = tok.find('=');
            changes[at].push_back({ tok.substr(0, eq), atof(tok.c_str() + eq + 1) });
        }
    }
    auto* g = new fx::Graph;
    g->apply(p);
    std::vector<int16_t> out(blocks * fx::kBlock * 2);
    int16_t l[fx::kBlock], r[fx::kBlock];
    for (size_t b = 0; b < blocks; b++)
    {
        auto it = changes.find(b);
        if (it != changes.end())
        {
            for (auto& kv : it->second) set(p, kv.first, kv.second);
            g->apply(p);
        }
        g->process(&in[b * fx::kBlock], l, r);
        for (int i = 0; i < fx::kBlock; i++)
        {
            out[(b * fx::kBlock + i) * 2] = l[i];
            out[(b * fx::kBlock + i) * 2 + 1] = r[i];
        }
    }
    FILE* f = fopen(argv[2], "wb");
    if (!f) return 1;
    fwrite(out.data(), 2, out.size(), f);
    fclose(f);
    delete g;
    return 0;
}
