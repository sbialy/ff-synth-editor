#ifndef LIBS_AUDIO_EFFECT_SHORTDELAY_H_
#define LIBS_AUDIO_EFFECT_SHORTDELAY_H_
#include "AudioStream.h"

constexpr uint8_t MAX_SHORT_DELAY_VOICES = 12;
constexpr uint16_t MAX_SHORT_DELAY_TIME = 3500;
constexpr uint32_t MAX_DELAYLINE_LENGTH = 262144;

class AudioEffectShortDelay : public AudioStream
{
  public:
    AudioEffectShortDelay(void)
      : AudioStream(1, inputQueueArray)
    {
        blockUpdate();
    }

    void begin(float feedback,
               uint32_t time,
               bool pingPongEnabled,
               bool syncEnabled,
               uint8_t syncRatioIdx,
               float frequency);
    void setBuffer(int16_t* buffer);
    void setFeedback(float f);
    void setTime(float t);
    int getTime();
    void setRate(uint8_t r);
    void setPingpongEnable(bool pp);
    void setSyncEnable(bool se);
    void setFilterFrequency(float frequency);
    virtual void update(void);
    bool process(int16_t input[], int16_t outputLeft[], int16_t outputRight[], int sampleCount);
    void clear();
    void blockUpdate();
    void unblockUpdate();
    bool isSilent() const
    {
        return silentSamplesCount >= timeInSamples;
    }

  private:
    struct FilterCoeffs
    {
        int32_t a0;
        int32_t a1;
        int32_t b1;
    };

    static constexpr int kFilterCoeffsShift = 10;
    static constexpr int kFeedbackShift = 8;
    static constexpr uint16_t kMaxFilterCoeff = (1 << kFilterCoeffsShift) - 1;
    static constexpr float kMaxFeedback = 0.99f;
    static constexpr uint32_t delaylineLengthMask = MAX_DELAYLINE_LENGTH - 1;
    int16_t* pingpongDelaylineRight;
    int16_t* pingpongDelaylineLeft;
    int16_t* monoDelayline;
    uint32_t headIdx;
    audio_block_t* inputQueueArray[1];
    uint32_t timeInSamples;
    uint8_t feedback;
    bool noRefresh;
    uint8_t
      isPingpong; // uint8_t allows to use conditionally execution instead conditionally branch
    bool isSync;
    FilterCoeffs filterCoeffs;
    int32_t lastFilterInRight;
    int32_t lastFilterInLeft;
    int32_t lastFilterInMono;
    int32_t lastFilterOutRight;
    int32_t lastFilterOutLeft;
    int32_t lastFilterOutMono;
    uint32_t silentSamplesCount = MAX_DELAYLINE_LENGTH;
#ifdef AUDIO_NULL_IS_SILENCE
    // Consecutive samples (whole blocks) in which the values written to all three lines were zero: the last timeInSamples of them
    // fill the delay window. With the filters at rest a block of silent input can be skipped bit exactly.
    uint32_t quietSamplesCount = 0;

    // process() for update(): with kTrackQuiet the block is also checked for quietSamplesCount (silent input only, the loop then has a
    // few more instructions), without it the count is cleared (the input has sound)
    template<bool kTrackQuiet>
    bool processBlock(int16_t input[], int16_t outputLeft[], int16_t outputRight[], int sampleCount);
#endif
};

#endif /* LIBS_AUDIO_EFFECT_SHORTDELAY_H_ */
