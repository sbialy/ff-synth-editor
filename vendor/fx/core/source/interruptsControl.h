#ifndef SOURCE_INTERRUPTSCONTROL_H_
#define SOURCE_INTERRUPTSCONTROL_H_

extern void enableAudioInterrupt();
extern void disableAudioInterrupt();

#define ENABLE_AUDIO_INTERRUPTS()  enableAudioInterrupt()
#define DISABLE_AUDIO_INTERRUPTS() disableAudioInterrupt()

#endif /* SOURCE_INTERRUPTSCONTROL_H_ */
