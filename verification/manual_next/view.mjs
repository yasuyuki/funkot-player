const len = c => (Array.isArray(c) ? c.length : Object.keys(c).length);

const button = v => {
  if (!v.pending && !v.inflight) return 'Ready';
  if (!v.inflight) return 'Press accepted';
  if (v.pending) return 'Press accepted, a skip is out';
  if (len(v.chan) > 0) return 'Skip on its way';
  if (v.req) return 'Skip taken by the engine';
  if (v.fin || v.cur !== v.expected || v.xfade) return 'Skip out, track changing';
  return 'Stuck: presses ignored';
};

const engine = v => {
  const track = `track ${v.cur + 1}`;
  if (v.fin) return 'Last track ended';
  if (v.xfade) return `Mixing out of ${track}`;
  if (v.req) return `Playing ${track}, skip accepted`;
  return `Playing ${track}, next ${v.nxt ? 'ready' : 'not ready'}${v.fence ? ', saving' : ''}`;
};

const thread = pc => {
  if (pc === 'idle') return 'Not running';
  if (['lp', 'li', 'rd', 'se', 'sp'].includes(pc)) return 'Taking the press';
  if (['rp', 'rb', 'wp', 'wb', 'w1'].includes(pc)) return 'Waiting for the next track';
  if (['d1', 'd2', 'd3', 'd4', 'd5', 'd5c'].includes(pc)) return 'Checking the track';
  return 'Sending the skip';
};

const analysis = apc =>
  ({ set: 'Next file', lp: 'Checking for a skip', li: 'Checking for a skip', back: 'Yielding',
     dec: 'Decoding', rel: 'Decoding', done: 'Done' })[apc];

export const state = v => ({
  'Next button': button(v),
  Engine: engine(v),
  'Press 1': thread(v.hpc[1]),
  'Press 2': thread(v.hpc[2]),
  Analysis: analysis(v.apc),
});

const render = (from, to) => {
  if (len(from.chan) > 0 && len(to.chan) === 0) {
    return to.req && !from.req ? 'the engine takes the skip' : 'the engine drops the skip';
  }
  if (to.fin && !from.fin) return 'the last track ends';
  if (to.cur !== from.cur) return 'the next track starts';
  if (to.xfade && !from.xfade) return 'the mix into the next track starts';
  if (to.nxt && !from.nxt) return 'the next track is ready';
  return 'the audio plays on';
};

export const step = (action, from, to) => ({
  PressLocks: 'you press Next',
  PressLoadsPending: from.pending ? 'the press is ignored' : 'the press finds no earlier press',
  PressLoadsInFlight: from.inflight ? 'the press is ignored' : 'the press finds no skip out',
  PressReadsCurrent: 'the press reads the current track',
  PressStoresExpected: 'the press records the current track',
  PressStoresPending: 'the press is accepted',
  ReadyLoadsPrepared: to.hpc[1] === from.hpc[1] && to.hpc[2] === from.hpc[2] ? 'the thread polls' : 'the thread checks the next track',
  ReadyLoadsBusy: 'the thread checks the analysis',
  WaitLoadsPending: 'the wait thread checks the press',
  DispatchLoadsPending: 'the sender checks the press',
  DispatchLoadsDiscards: 'the sender reads the discard count',
  DispatchLoadsPrepared: 'the sender checks the next track',
  DispatchLoadsExpected: 'the sender reads the recorded track',
  DispatchReadsSnapshot: 'the sender sees the recorded track still playing',
  DispatchDropsStale: 'the sender drops the press: the track changed',
  DispatchSetsInFlight: 'the sender marks a skip out',
  DispatchSends: 'the sender sends the skip',
  DispatchClearsPending: 'the sender clears the press',
  DispatchRechecksDiscards: 'the sender rechecks the discard count',
  DispatchClearsInFlight: 'a discard during the send frees the button',
  CallbackRenders: render(from, to),
  CallbackStoresPrepared: 'the audio callback reports the next track',
  CallbackChecksCompleted: 'the audio callback compares the track',
  CallbackClearsPending: from.pending && !to.pending ? 'the track changed, so the press is done' : 'the audio callback finds the press still open',
  CallbackClearsInFlight: from.inflight && !to.inflight ? 'the track changed, so the skip is done' : 'the audio callback finds the skip still open',
  CallbackPublishes: 'the audio callback publishes the track',
  SaveBegins: 'a list or queue change starts saving',
  SaveAborts: 'the save fails',
  SaveCommits: 'the save commits and drops queued skips',
  RevokeTakesNext: 'a manual track takes the next slot',
  ForgetClearsPrepared: 'the discard clears the next track',
  ForgetCountsDiscard: 'the discard is counted',
  ForgetClearsInFlight: 'the discard frees the button',
  DiscardReleasesLock: 'the discard is published',
  AnalysisSetsBusy: 'the analysis claims the CPU',
  AnalysisLoadsPending: 'the analysis checks for a press',
  AnalysisLoadsInFlight: 'the analysis checks for a skip out',
  AnalysisYields: 'the analysis yields',
  AnalysisDecodes: 'the analysis finishes decoding',
  AnalysisReleases: 'the analysis releases the CPU',
})[action];

export const group = v => (v.pending || v.inflight ? 'press' : 'idle');
export const colors = { idle: 'tan', press: 'blue' };
export const title = 'Next button';
