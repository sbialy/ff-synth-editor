#include "effect_shortDelay.h"
#include <algorithm>
#include "Audio.h"
#include "mtSequencer.h"
#include "utility/dspinst.h"

static int16_t zeroblock[AUDIO_BLOCK_SAMPLES] = {};

const float tempoSyncRatesShortDelay[19] = {
    8,        6,    4,      3,        2,     1.5,      1,      0.75,     0.5,     0.375,
    0.333333, 0.25, 0.1875, 0.166667, 0.125, 0.083333, 0.0625, 0.041667, 0.03125,
};
extern int16_t externalRamDelayBuff[];

AUDIO_CORE_FLASH void AudioEffectShortDelay::begin(float feedback,
                                             uint32_t timeMs,
                                             bool pingPongEnabled,
                                             bool syncEnabled,
                                             uint8_t syncRateIdx,
                                             float frequency)
{
    setPingpongEnable(pingPongEnabled);
    setSyncEnable(syncEnabled);
    setTime(timeMs);
    setFeedback(feedback);
    setRate(syncRateIdx);
    setFilterFrequency(frequency);

    setBuffer(externalRamDelayBuff);
    unblockUpdate();
}

AUDIO_CORE_FLASH void AudioEffectShortDelay::setBuffer(int16_t* buffer)
{
    pingpongDelaylineRight = &buffer[0];
    pingpongDelaylineLeft = &buffer[MAX_DELAYLINE_LENGTH];
    monoDelayline = &buffer[2 * MAX_DELAYLINE_LENGTH];

    clear();
}

AUDIO_CORE_FLASH void AudioEffectShortDelay::setFeedback(float feedback)
{
    if (feedback > kMaxFeedback)
        feedback = kMaxFeedback;
    else if (feedback < 0.0f)
        feedback = 0.0f;

    //	__disable_irq();
    AudioNoInterrupts();
    this->feedback = UINT8_MAX * feedback;
    AudioInterrupts();
    //	__enable_irq();
}
AUDIO_CORE_FLASH void AudioEffectShortDelay::setTime(float time)
{
    if (time > MAX_SHORT_DELAY_TIME)
        time = MAX_SHORT_DELAY_TIME;
    //	__disable_irq();
    AudioNoInterrupts();
    timeInSamples = (uint32_t)(time * 44.1f);
    //	__enable_irq();
    AudioInterrupts();
}

AUDIO_CORE_FLASH int AudioEffectShortDelay::getTime()
{
    return int(timeInSamples / 44.1f);
}

AUDIO_CORE_FLASH void AudioEffectShortDelay::setRate(uint8_t syncRateIdx)
{
    if (!isSync)
        return;

    float tempo = sequencer.getCurrentTempo();

    float freq = (tempo / 15.0f); // *4,bo  beat = 4 step i /60, bo min = 60s
    float timeMs = (1000 / freq) * tempoSyncRatesShortDelay[syncRateIdx];

    setTime(timeMs);
}
AUDIO_CORE_FLASH void AudioEffectShortDelay::setPingpongEnable(bool pingPongEnabled)
{
    isPingpong = pingPongEnabled;
}
AUDIO_CORE_FLASH void AudioEffectShortDelay::setSyncEnable(bool syncEnabled)
{
    isSync = syncEnabled;
}

AUDIO_CORE_FLASH void AudioEffectShortDelay::setFilterFrequency(float frequency)
{
    float Qc = 2 * M_PI * frequency / 44100.0f;
    float y = (cosf(Qc) / (1 + sinf(Qc)));

    filterCoeffs.a0 = kMaxFilterCoeff * ((1.0f - y) / 2.0f);
    filterCoeffs.a1 = filterCoeffs.a0;
    filterCoeffs.b1 = kMaxFilterCoeff * (-y);

    lastFilterInLeft = 0;
    lastFilterInRight = 0;
    lastFilterInMono = 0;
    lastFilterOutLeft = 0;
    lastFilterOutRight = 0;
    lastFilterOutMono = 0;
}

AUDIO_CORE_FLASH void AudioEffectShortDelay::clear()
{
    blockUpdate();
    //    AudioNoInterrupts();
    headIdx = 0;
    lastFilterInLeft = 0;
    lastFilterInRight = 0;
    lastFilterInMono = 0;
    lastFilterOutLeft = 0;
    lastFilterOutRight = 0;
    lastFilterOutMono = 0;
    silentSamplesCount = MAX_DELAYLINE_LENGTH;
#ifdef AUDIO_NULL_IS_SILENCE
    quietSamplesCount = MAX_DELAYLINE_LENGTH;
#endif

    memset(pingpongDelaylineRight, 0, MAX_DELAYLINE_LENGTH * sizeof(int16_t));
    memset(pingpongDelaylineLeft, 0, MAX_DELAYLINE_LENGTH * sizeof(int16_t));
    memset(monoDelayline, 0, MAX_DELAYLINE_LENGTH * sizeof(int16_t));
    //    AudioInterrupts();
    unblockUpdate();
}

AUDIO_CORE_FLASH void AudioEffectShortDelay::blockUpdate()
{
    noRefresh = true;
}
AUDIO_CORE_FLASH void AudioEffectShortDelay::unblockUpdate()
{
    noRefresh = false;
}

#ifdef AUDIO_NULL_IS_SILENCE
static bool isZeroOrMissing(const audio_block_t* block)
{
    if (block == nullptr)
        return true;
    const uint32_t* p = (const uint32_t*)block->data;
    for (int i = 0; i < AUDIO_BLOCK_SAMPLES / 2; i++)
    {
        if (p[i] != 0)
            return false;
    }
    return true;
}
#endif

AUDIO_CORE_RAM void AudioEffectShortDelay::update(void)
{
    audio_block_t* input;
    audio_block_t* outputLeft;
    audio_block_t* outputRight;

    input = receiveReadOnly(0);
#ifdef AUDIO_NULL_IS_SILENCE
    const bool silentInput = isZeroOrMissing(input);
    if (!noRefresh && timeInSamples >= 1 && quietSamplesCount >= timeInSamples &&
        (lastFilterInRight | lastFilterInLeft | lastFilterInMono | lastFilterOutRight | lastFilterOutLeft | lastFilterOutMono) == 0 &&
        silentInput)
    {
        // Silent input, the last timeInSamples values written to the lines were zero (so the whole delay window is) and the filters are
        // at rest: delayed samples, filter outputs and the values to write are zero, as in every one of the 128 steps of process().
        // What process() would do is write 128 zeros to each line, move the head and count 128 silent samples. Same state, same output
        // (zero, so nothing is transmitted).
        const uint32_t headSampleIdx = headIdx & delaylineLengthMask; // a multiple of 128, the block never wraps
        memset(&pingpongDelaylineRight[headSampleIdx], 0, AUDIO_BLOCK_SAMPLES * sizeof(int16_t));
        memset(&pingpongDelaylineLeft[headSampleIdx], 0, AUDIO_BLOCK_SAMPLES * sizeof(int16_t));
        memset(&monoDelayline[headSampleIdx], 0, AUDIO_BLOCK_SAMPLES * sizeof(int16_t));
        headIdx += AUDIO_BLOCK_SAMPLES;
        silentSamplesCount = std::min<uint32_t>(silentSamplesCount + AUDIO_BLOCK_SAMPLES, MAX_DELAYLINE_LENGTH);
        quietSamplesCount = std::min<uint32_t>(quietSamplesCount + AUDIO_BLOCK_SAMPLES, MAX_DELAYLINE_LENGTH);
        if (input != nullptr)
        {
            release(input);
        }
        return;
    }
#endif
    outputLeft = allocate();
    outputRight = allocate();

    bool processed = false;

    if (outputLeft != nullptr && outputRight != nullptr)
    {
#ifdef AUDIO_NULL_IS_SILENCE
        int16_t* const inputData = input != nullptr ? input->data : zeroblock;
        processed = silentInput
                      ? processBlock<true>(inputData, outputLeft->data, outputRight->data, AUDIO_BLOCK_SAMPLES)
                      : processBlock<false>(inputData, outputLeft->data, outputRight->data, AUDIO_BLOCK_SAMPLES);
#else
        processed = process(input != nullptr ? input->data : zeroblock,
                            outputLeft->data,
                            outputRight->data,
                            AUDIO_BLOCK_SAMPLES);
#endif
    }

    if (outputRight != nullptr)
    {
        if (processed)
        {
            transmit(outputRight, 0);
        }
        release(outputRight);
    }
    if (outputLeft != nullptr)
    {
        if (processed)
        {
            transmit(outputLeft, 1);
        }
        release(outputLeft);
    }
    if (input != nullptr)
    {
        release(input);
    }
}

#ifdef AUDIO_NULL_IS_SILENCE
AUDIO_CORE_RAM bool AudioEffectShortDelay::process(int16_t input[],
                                               int16_t outputLeft[],
                                               int16_t outputRight[],
                                               int sampleCount)
{
    return processBlock<false>(input, outputLeft, outputRight, sampleCount);
}

template<bool kTrackQuiet>
AUDIO_CORE_RAM bool AudioEffectShortDelay::processBlock(int16_t input[],
                                                    int16_t outputLeft[],
                                                    int16_t outputRight[],
                                                    int sampleCount)
#else
AUDIO_CORE_RAM bool AudioEffectShortDelay::process(int16_t input[],
                                               int16_t outputLeft[],
                                               int16_t outputRight[],
                                               int sampleCount)
#endif
{
    if (noRefresh == true)
    {
        return false;
    }

    int32_t newDelayedSampleLeft = 0;
    int32_t newDelayedSampleRight = 0;
    int32_t newDelayedSampleMono = 0;
#ifdef AUDIO_NULL_IS_SILENCE
    int32_t anyNonZero = 0;
#endif

    for (int sample = 0; sample < sampleCount; sample++)
    {
        uint32_t delayedSampleIdx = (headIdx - timeInSamples) & delaylineLengthMask;
        int16_t delayedSampleRight = pingpongDelaylineRight[delayedSampleIdx];
        int16_t delayedSampleLeft = pingpongDelaylineLeft[delayedSampleIdx];
        int16_t delayedSampleMono = monoDelayline[delayedSampleIdx];

        int32_t filteredSampleRight =
          (filterCoeffs.a0 * delayedSampleRight + filterCoeffs.a1 * lastFilterInRight -
           filterCoeffs.b1 * lastFilterOutRight) /
          (1 << kFilterCoeffsShift);
        int32_t filteredSampleLeft =
          (filterCoeffs.a0 * delayedSampleLeft + filterCoeffs.a1 * lastFilterInLeft -
           filterCoeffs.b1 * lastFilterOutLeft) /
          (1 << kFilterCoeffsShift);
        int32_t filteredSampleMono =
          (filterCoeffs.a0 * delayedSampleMono + filterCoeffs.a1 * lastFilterInMono -
           filterCoeffs.b1 * lastFilterOutMono) /
          (1 << kFilterCoeffsShift);

        lastFilterInRight = delayedSampleRight;
        lastFilterInLeft = delayedSampleLeft;
        lastFilterInMono = delayedSampleMono;
        lastFilterOutRight = filteredSampleRight;
        lastFilterOutLeft = filteredSampleLeft;
        lastFilterOutMono = filteredSampleMono;

        int16_t outL = isPingpong ? filteredSampleLeft : filteredSampleMono;
        int16_t outR = isPingpong ? filteredSampleRight : filteredSampleMono;
        *outputLeft++ = outL;
        *outputRight++ = outR;

        int32_t inputShifted = ((*input++) << kFeedbackShift);

        newDelayedSampleLeft = inputShifted + filteredSampleRight * feedback;
        newDelayedSampleRight = filteredSampleLeft * feedback;
        newDelayedSampleMono = inputShifted + filteredSampleMono * feedback;

        static constexpr int32_t kFeedbackRoundBias = (1 << kFeedbackShift) - 1;
        int16_t saturatedLeft = (int16_t)signed_saturate_rshift(
          newDelayedSampleLeft + (newDelayedSampleLeft < 0 ? kFeedbackRoundBias : 0),
          16,
          kFeedbackShift);
        int16_t saturatedRight = (int16_t)signed_saturate_rshift(
          newDelayedSampleRight + (newDelayedSampleRight < 0 ? kFeedbackRoundBias : 0),
          16,
          kFeedbackShift);
        int16_t saturatedMono = (int16_t)signed_saturate_rshift(
          newDelayedSampleMono + (newDelayedSampleMono < 0 ? kFeedbackRoundBias : 0),
          16,
          kFeedbackShift);

#ifdef AUDIO_NULL_IS_SILENCE
        if constexpr (kTrackQuiet)
        {
            anyNonZero |= saturatedLeft | saturatedRight | saturatedMono;
        }
#endif
        bool isSampleSilent =
          isPingpong ? (outL == 0 && outR == 0 && saturatedLeft == 0 && saturatedRight == 0)
                     : (outL == 0 && saturatedMono == 0);
        if (isSampleSilent)
        {
            if (silentSamplesCount < MAX_DELAYLINE_LENGTH)
            {
                silentSamplesCount++;
            }
        }
        else
        {
            silentSamplesCount = 0;
        }

        uint32_t headSampleIdx = headIdx++ & delaylineLengthMask;

        pingpongDelaylineLeft[headSampleIdx] = saturatedLeft;
        pingpongDelaylineRight[headSampleIdx] = saturatedRight;
        monoDelayline[headSampleIdx] = saturatedMono;
    }
#ifdef AUDIO_NULL_IS_SILENCE
    if constexpr (kTrackQuiet)
    {
        quietSamplesCount =
          anyNonZero == 0 ? std::min<uint32_t>(quietSamplesCount + sampleCount, MAX_DELAYLINE_LENGTH) : 0;
    }
    else
    {
        quietSamplesCount = 0;
    }
#endif

    return true;
}
