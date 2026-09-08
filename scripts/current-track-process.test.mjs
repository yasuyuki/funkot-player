// Native Windows smoke: launch the actual compiled application with an empty CI user profile.
// This checks the real listener lifecycle, not real music playback or capture.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import net from 'node:net';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

async function freePort() {
  const listener=net.createServer();
  listener.listen(0,'127.0.0.1');await once(listener,'listening');
  const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));return port;
}
async function stop(child) {
  if(child.exitCode!==null||child.signalCode!==null)return;
  const exited=once(child,'exit');child.kill();await exited;
}

test('built Windows app serves only an opt-in loopback read API', {skip:process.platform!=='win32',timeout:30000}, async t=>{
  const port=await freePort();
  const exe=path.resolve('src-tauri/target/release/funkot-player.exe');
  const child=spawn(exe,[],{env:{...process.env,FUNKOT_CURRENT_TRACK_PORT:String(port)},stdio:'ignore'});
  await once(child,'spawn');
  t.after(()=>stop(child));
  const url=`http://127.0.0.1:${port}/now-playing`;
  let response;
  while(!response) {
    assert.equal(child.exitCode,null,'compiled app exited before the endpoint was available');
    if(t.signal.aborted)throw t.signal.reason;
    try{response=await fetch(url,{signal:AbortSignal.any([t.signal,AbortSignal.timeout(1000)])});}
    catch{await delay(50,undefined,{signal:t.signal});}
  }
  assert.equal(response.status,200);
  assert.match(response.headers.get('content-type'),/application\/json/);
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.deepEqual(await response.json(),{version:1,title:'',artist:'',playing:false});
  assert.equal((await fetch(url,{method:'POST'})).status,405);
  assert.notEqual((await fetch(url,{headers:{Origin:'https://example.com'}})).status,200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/unknown`)).status,404);
  await stop(child);
  await assert.rejects(fetch(url,{signal:AbortSignal.timeout(1000)}));
});
