// The definitions of the engines that arrive at run time (modules.cpp), compiled without -DSYNTH_ENGINE_<NAME> for them so that they are
// not the const ones open_engine.h declares: the name and the type id are the public numbers of engine_list.h, everything else is empty
// until the module is attached. engineTypes() in poly_host.cpp leaves an engine out while its `engine` is null. Same order as kSpecs of
// modules.cpp.
#include "open_engine.h"

namespace polysynth::open
{
EngineDef kPhzDef = { "PHZ", 0x82, nullptr, 0, nullptr, 0, nullptr, 0, -1, 1, nullptr, false };
EngineDef kPlkDef = { "PLK", 0x8A, nullptr, 0, nullptr, 0, nullptr, 0, -1, 1, nullptr, false };
EngineDef kJu6Def = { "JU6", 0x81, nullptr, 0, nullptr, 0, nullptr, 0, -1, 1, nullptr, false };
}

polysynth::open::EngineDef& runtimeDef(int slot)
{
    polysynth::open::EngineDef* defs[] = { &polysynth::open::kPhzDef, &polysynth::open::kPlkDef, &polysynth::open::kJu6Def };
    return *defs[slot];
}
