const phase = (v, i) => {
  if (v.parent[i] === 'released') return v.scratch[i] ? 'Leaked scratch' : 'Scratch removed';
  if (v.child[i] === 'exited') return 'Child exited';
  if (!v.scratch[i] && v.child[i] !== 'absent') return 'Child lost its scratch';
  if (v.child[i] === 'returned') return 'Test returned; loader may still write';
  if (v.child[i] === 'running') return 'Test running';
  return 'Preparing fixture';
};
export const state = v => ({
  'First fixture': phase(v, 1),
  'Second fixture': phase(v, 2),
  Checkout: v.checkoutCache ? 'Cache leaked into checkout' : 'Checkout unchanged',
});
export const step = action => ({
  Allocate: 'parent creates scratch',
  Spawn: 'parent starts child in scratch',
  ReturnFromTest: 'test body returns',
  WriteCache: 'loader writes relative cache',
  ExitChild: 'child process exits',
  RemoveScratch: 'parent removes scratch',
  Done: 'fixtures complete',
})[action] ?? action;
export const title = 'Native test cache ownership';
