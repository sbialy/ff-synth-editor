#ifndef LIBS_AUDIO_DSPAPPLYGAIN_H_
#define LIBS_AUDIO_DSPAPPLYGAIN_H_

#include "mtStructs.h"
#include "stdint.h"

#define MULTI_UNITYGAIN 65536

void applyGain(int16_t* data, int32_t& target_mult, int32_t& previous_mult);
void applyGainAndCopy(int32_t* dst,
                      const int16_t* in,
                      int32_t& target_mult,
                      int32_t& previous_mult);
void applyGainThenAdd(int16_t* data,
                      const int16_t* in,
                      int32_t& target_mult,
                      int32_t& previous_mult);
void applyGainThenAdd(int32_t* dst,
                      const int16_t* in,
                      int32_t& target_mult,
                      int32_t& previous_mult);
void saturate(int16_t* dstBuf, const int32_t* inBuf, SaturationType saturationType);

#endif /* LIBS_AUDIO_DSPAPPLYGAIN_H_ */
