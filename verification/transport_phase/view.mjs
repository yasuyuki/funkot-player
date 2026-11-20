const screen = {
  idle: 'Not started',
  starting: 'Starting',
  playing: 'Playing',
  paused: 'Paused',
  stalled: 'Stalled (nothing ready)',
  failed: 'Failed',
  disconnected: 'Output lost',
};
const audio = v => {
  if (v.spc === 'spawnFailed') return 'Never started';
  if (v.tpc === 'dead') return 'Gave up';
  if (v.tpc === 'none') return v.spc === 'idle' ? 'Not started' : 'Being started';
  if (v.tpc === 'setup') return 'Preparing engine';
  if (v.tpc === 'opening') return 'Opening output';
  return v.stream && v.tpc !== 'dropping' ? 'Output open' : 'Reopening output';
};
export const state = v => ({ Screen: screen[v.phase], 'Audio thread': audio(v) });
export const step = (action, from, to) => ({
  StartPublishesStarting: 'you press start',
  StartSpawnsAudioThread: 'the audio thread starts',
  StartSpawnFails: 'the audio thread cannot start',
  SetupFails: 'there is no usable output device or engine',
  EnginePublished: 'the engine is ready',
  FirstOpenSucceeds: 'the output opens',
  FirstOpenFails: 'the output cannot open',
  WatchdogSeesNoStream: 'the watchdog sees no output',
  ReopenSucceeds: 'the output reopens',
  ReopenFails: 'the reopen fails',
  WatchdogLosesStream: 'the watchdog finds the output stuck',
  WatchdogDropsStream: 'the watchdog closes the output',
  DeviceLost: null,
  DeviceBack: null,
  CallbackRenders: null,
  CallbackPausesFinished: 'the last track ends',
  CallbackStoresPhase: 'the audio callback reports what it heard',
  PressToggle: 'you press pause or play',
  ToggleResumesEngine: 'the ended engine resumes',
  ToggleFlips: 'the pause flag flips',
  PressSet: 'the notification asks for pause or play',
  SetResumesEngine: 'the ended engine resumes',
  SetSwaps: 'the pause flag is set',
  PauseReadsPhase: from.phase !== to.phase ? 'the pause is shown' : 'the pause reads the screen state',
  PauseStoresPaused: 'the pause is shown',
  Done: null,
})[action] ?? action;
export const group = v => (v.tpc === 'dead' || v.spc === 'spawnFailed' ? 'over' : v.phase === 'idle' ? 'before' : 'live');
export const colors = { before: 'tan', live: 'blue', over: 'orange' };
export const title = 'Transport phase';
