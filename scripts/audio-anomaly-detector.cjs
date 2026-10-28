// Issue #53 diagnostic: stereo 48 kHz IEEE-float process loopback only.
// Calibration is deliberately tied to two real clean captures of the exact ABA fixture.
// The thresholds are measured from their aligned residual and verified by injection.
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');

const RATE = 48000, WINDOW = 96, ACTIVE_LEVEL = 1e-4;
const keys = ['rms', 'peak', 'difference', 'high', 'impulse', 'short8', 'short32', 'residual8', 'residual32'];
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function wav(file) {
  const bytes = fs.readFileSync(file);
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw Error(`Invalid WAV: ${file}`);
  let data, size, fmt;
  for (let p = 12; p + 8 <= bytes.length;) {
    const id = bytes.toString('ascii', p, p + 4), n = bytes.readUInt32LE(p + 4);
    if (id === 'fmt ') {
      const tag=bytes.readUInt16LE(p+8);
      const isFloat=tag===3||(tag===0xfffe&&n>=40&&bytes.readUInt32LE(p+32)===3);
      fmt=[isFloat,bytes.readUInt16LE(p+10),bytes.readUInt32LE(p+12),bytes.readUInt16LE(p+22)];
    }
    if (id === 'data') { data = p + 8; size = n; break; }
    p += 8 + n + n % 2;
  }
  if (!data || fmt.join() !== 'true,2,48000,32' || size % 8 || data + size > bytes.length) throw Error(`Unexpected PCM format: ${file}`);
  return {bytes, data, frames:size / 8, sample:(frame,ch) => bytes.readFloatLE(data + frame * 8 + ch * 4)};
}
function csv(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(x => x && !x.startsWith('#'));
  const head = lines.shift().split(',');
  return lines.map(line => {
    const fields=line.split(',');
    if(fields.length!==head.length || fields.some(v=>!/^\d+$/.test(v))) throw Error(`Malformed numeric CSV row: ${file}`);
    return Object.fromEntries(fields.map((v,i) => [head[i], Number(v)]));
  });
}
function active(w) {
  let first=-1, last=-1;
  for (let i=0;i<w.frames;i+=48) {
    if (Math.max(Math.abs(w.sample(i,0)),Math.abs(w.sample(i,1))) > ACTIVE_LEVEL) { first=i; break; }
  }
  if (first<0) throw Error('No active PCM');
  for (let i=first;i<Math.min(w.frames,first+48);i++) {
    if (Math.max(Math.abs(w.sample(i,0)),Math.abs(w.sample(i,1))) > ACTIVE_LEVEL) { first=i; break; }
  }
  for (let i=w.frames-1;i>=first;i-=48) {
    if (Math.max(Math.abs(w.sample(i,0)),Math.abs(w.sample(i,1))) > ACTIVE_LEVEL) { last=i; break; }
  }
  return {first,last};
}
function align(target, ref, ta, ra) {
  let best={correlation:-Infinity, offset:0};
  const t=ta.first+RATE*10, r=ra.first+RATE*10;
  for (let shift=-240;shift<=240;shift++) {
    let xy=0, xx=0, yy=0;
    for (let j=0;j<RATE;j+=64) {
      const x=target.sample(t+j,0), y=ref.sample(r+shift+j,0);
      xy+=x*y; xx+=x*x; yy+=y*y;
    }
    const correlation=xy/Math.sqrt(xx*yy);
    if (correlation>best.correlation) best={correlation, offset:r+shift-t};
  }
  return best;
}
function fit(target,ref,start,offset) {
  let sx=0, sy=0, sxx=0, sxy=0, n=0;
  const available=Math.min(RATE,target.frames-start,ref.frames-start-offset);
  for (let i=0;i<available;i+=32) for (let ch=0;ch<2;ch++) {
    const x=ref.sample(start+i+offset,ch), y=target.sample(start+i,ch);
    sx+=x; sy+=y; sxx+=x*x; sxy+=x*y; n++;
  }
  const gain=(sxy-sx*sy/n)/(sxx-sx*sx/n);
  return {gain, dc:(sy-gain*sx)/n};
}
function metrics(target,ref,start,offset,gain,dc,inject) {
  const residual=new Float64Array((WINDOW+2)*2), curve=new Float64Array(WINDOW*2);
  let sum=0, peak=0, diff=0, high=0, impulse=0;
  const impulseChannels=[0,0];
  for (let i=-1;i<=WINDOW;i++) for(let ch=0;ch<2;ch++) {
    const frame=start+i, ordinary=target.sample(frame,ch);
    const value=inject ? inject(frame,ch,ordinary) : ordinary;
    const r=value-(gain*ref.sample(frame+offset,ch)+dc);
    residual[(i+1)*2+ch]=r;
    if(i>=0&&i<WINDOW){sum+=r*r;peak=Math.max(peak,Math.abs(r));}
  }
  for (let i=2;i<WINDOW-2;i++) for(let ch=0;ch<2;ch++) {
    const k=(i+1)*2+ch;
    const d=residual[k]-residual[k-2]; diff+=d*d;
    const h=residual[k]-(residual[k-4]+residual[k-2]+residual[k]+residual[k+2]+residual[k+4])/5;
    high+=h*h;
  }
  for(let i=0;i<WINDOW;i++)for(let ch=0;ch<2;ch++){
    const k=(i+1)*2+ch;
    const v=Math.abs(residual[k-2]-2*residual[k]+residual[k+2]);
    curve[i*2+ch]=v;impulse=Math.max(impulse,v);impulseChannels[ch]=Math.max(impulseChannels[ch],v);
  }
  const result={rms:Math.sqrt(sum/(WINDOW*2)),peak,difference:Math.sqrt(diff/((WINDOW-4)*2)),high:Math.sqrt(high/((WINDOW-4)*2)),impulse,impulseChannels};
  for(const width of [8,32]){
    let highMax=0,residualMax=0;
    for(let startFrame=0;startFrame<=WINDOW-width;startFrame+=8)for(let ch=0;ch<2;ch++){
      let highSum=0,residualSum=0;
      for(let j=0;j<width;j++){
        highSum+=curve[(startFrame+j)*2+ch]**2;
        residualSum+=residual[(startFrame+j+1)*2+ch]**2;
      }
      highMax=Math.max(highMax,Math.sqrt(highSum/width));
      residualMax=Math.max(residualMax,Math.sqrt(residualSum/width));
    }
    result['short'+width]=highMax;
    result['residual'+width]=residualMax;
  }
  return result;
}
function eachWindow(target,ref,inject,visit) {
  const ta=active(target),ra=active(ref),alignment=align(target,ref,ta,ra);
  if (alignment.correlation<0.99) throw Error(`Fixture/alignment mismatch: correlation ${alignment.correlation}`);
  const end=Math.min(ta.last-WINDOW,ref.frames-alignment.offset-WINDOW);
  for(let sec=Math.floor(ta.first/RATE);sec*RATE<end;sec++) {
    const start=Math.max(ta.first,sec*RATE), stop=Math.min(end,(sec+1)*RATE-WINDOW);
    if (stop<=start) continue;
    const {gain,dc}=fit(target,ref,start,alignment.offset);
    if (!Number.isFinite(gain)||Math.abs(gain-1)>0.05||Math.abs(dc)>0.05) throw Error(`Gain/DC mismatch at ${start}`);
    for(let frame=start;frame<=stop;frame+=WINDOW) visit(frame,metrics(target,ref,frame,alignment.offset,gain,dc,inject),ta);
  }
  return {active:ta,alignment};
}
function offlineInput(manifestFile) {
  const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
  if(manifest.schema!==1||manifest.sampleRate!==RATE||!Array.isArray(manifest.segments))throw Error('Invalid offline manifest');
  const file=path.resolve(path.dirname(manifestFile),manifest.file);
  if(sha(file)!==manifest.sha256)throw Error('Offline reference hash changed');
  return {manifest,file,wave:wav(file),manifestSha256:sha(manifestFile)};
}
function localOffset(target,ref,targetFrame,seed) {
  let best={correlation:-Infinity,referenceFrame:seed};
  const count=RATE*3/4;
  function correlation(refFrame,step) {
    let xy=0,xx=0,yy=0;
    for(let j=0;j<count;j+=step){
      const x=target.sample(targetFrame+j,0),y=ref.sample(refFrame+j,0);
      xy+=x*y;xx+=x*x;yy+=y*y;
    }
    return xy/Math.sqrt(xx*yy);
  }
  for(let shift=-1024;shift<=1024;shift+=16){
    const p=seed+shift;
    if(p<0||p+count>=ref.frames)continue;
    const c=correlation(p,32);
    if(c>best.correlation)best={correlation:c,referenceFrame:p};
  }
  const coarse=best.referenceFrame;
  for(let shift=-16;shift<=16;shift++){
    const p=coarse+shift;
    if(p<0||p+count>=ref.frames)continue;
    const c=correlation(p,16);
    if(c>best.correlation)best={correlation:c,referenceFrame:p};
  }
  return best;
}
function eachOfflineWindow(target,offline,visit) {
  const range=active(target),ref=offline.wave;
  let windows=0,skipped=0,minCorrelation=Infinity,minGain=Infinity,maxGain=-Infinity;
  const skippedByReason={segment:0,correlation:0,range:0,gain:0};
  const end=range.last-WINDOW;
  for(let sec=Math.floor(range.first/RATE);sec*RATE<end;sec++){
    const start=Math.max(range.first,sec*RATE),stop=Math.min(end,(sec+1)*RATE-WINDOW);
    if(stop<=start)continue;
    const relative=start-range.first;
    const segment=offline.manifest.segments.find(s=>relative>=s.captureStartFrame&&relative<s.captureEndFrame);
    if(!segment||stop-range.first>=segment.captureEndFrame){skipped++;skippedByReason.segment++;continue;}
    const probe=start,seed=probe-range.first+segment.referenceFrameAdd;
    const match=localOffset(target,ref,probe,seed);
    if(match.correlation<0.995){skipped++;skippedByReason.correlation++;continue;}
    const offset=match.referenceFrame-probe;
    if(start+offset<1||stop+offset+WINDOW>=ref.frames){skipped++;skippedByReason.range++;continue;}
    const {gain,dc}=fit(target,ref,start,offset);
    minGain=Math.min(minGain,gain);maxGain=Math.max(maxGain,gain);
    if(!Number.isFinite(gain)||Math.abs(gain-1)>0.5||Math.abs(dc)>0.05){skipped++;skippedByReason.gain++;continue;}
    minCorrelation=Math.min(minCorrelation,match.correlation);
    for(let frame=start;frame<=stop;frame+=WINDOW){visit(frame,metrics(target,ref,frame,offset,gain,dc,null),{offset,correlation:match.correlation,gain,dc});windows++;}
  }
  return {windows,skippedSeconds:skipped,skippedByReason,minCorrelation:Number.isFinite(minCorrelation)?minCorrelation:null,minGain,maxGain};
}
function featureScore(m,t) {
  const ratio=(value,threshold)=>value/Math.max(threshold,1e-12);
  return Math.max(
    Math.min(ratio(m.rms,t.rms),Math.max(ratio(m.difference,t.difference),ratio(m.high,t.high))),
    Math.min(ratio(m.peak,t.peak),ratio(m.high,t.high)),
    Math.min(ratio(m.impulse,t.impulse),ratio(m.short8,t.short8)),
    Math.min(ratio(m.short8,t.short8),ratio(m.short32,t.short32)),
    Math.min(ratio(m.residual8,t.residual8),ratio(m.short8,t.short8))
  );
}
function featurePositive(m,t) { return featureScore(m,t)>1; }
function continuity(w,first,last,inject) {
  let zero=0, maxZero=0, nonfinite=null, firstGap=null, maxDelta=0, deltaFrame=0;
  for(let frame=first;frame<=last;frame++) {
    let bothZero=true;
    for(let ch=0;ch<2;ch++) {
      let v=w.sample(frame,ch); if(inject)v=inject(frame,ch,v);
      if(!Number.isFinite(v)) nonfinite??=frame;
      if(Math.abs(v)>1e-6) bothZero=false;
      if(frame>first) {
        let before=w.sample(frame-1,ch); if(inject)before=inject(frame-1,ch,before);
        const delta=Math.abs(v-before);
        if(delta>maxDelta){maxDelta=delta;deltaFrame=frame;}
      }
    }
    if(bothZero) { if(++zero===RATE/2000) firstGap=frame-zero+1; maxZero=Math.max(maxZero,zero); }
    else zero=0;
  }
  return {firstGap,maxZero,nonfinite,maxDelta,deltaFrame};
}
function qpcAt(packets,frame) {
  let lo=0,hi=packets.length;
  while(lo<hi){const mid=(lo+hi)>>1;if(packets[mid].file_frame<=frame)lo=mid+1;else hi=mid;}
  const p=packets[Math.max(0,lo-1)];
  return p.qpc_100ns+Math.round((frame-p.file_frame)*1e7/RATE);
}
function callbackBaseline(wavFile,range) {
  const rows=csv(path.join(path.dirname(wavFile),'callback.csv'));
  const packets=csv(wavFile+'.packets.csv');
  const firstQpc=qpcAt(packets,range.first),lastQpc=qpcAt(packets,range.last);
  const gaps=[], playback=[];
  for(let i=1;i<rows.length;i++) if(rows[i].main_frames && rows[i-1].main_frames && rows[i].start_qpc>=firstQpc && rows[i].start_qpc<=lastQpc) {
    gaps.push((rows[i].start_qpc-rows[i-1].start_qpc)/10000);
    playback.push((rows[i].playback_100ns-rows[i-1].playback_100ns)/10000);
  }
  const stats=v=>{v.sort((a,b)=>a-b);return {p999:v[Math.floor(v.length*.999)],max:v.at(-1)};};
  return {callbackGapMs:stats(gaps),playbackGapMs:stats(playback)};
}
function timing(packetFile,callbackFile,frames,activeRange,thresholds) {
  const packets=csv(packetFile),callbacks=csv(callbackFile);
  if(!packets.length||!callbacks.length) return {classification:'capture_fault',reason:'missing packet/callback rows'};
  let packetGap=null, flag=null;
  for(let i=0;i<packets.length;i++) {
    const p=packets[i], expected=i?packets[i-1].file_frame+packets[i-1].frames:0;
    if(p.file_frame!==expected) packetGap??=p.file_frame;
    if(p.flags!==0) flag??=p.file_frame;
  }
  if(packets.at(-1).file_frame+packets.at(-1).frames!==frames) packetGap??=frames;
  let seqGap=null, lock=null, interval=null, playback=null;
  const firstQpc=qpcAt(packets,activeRange.first),lastQpc=qpcAt(packets,activeRange.last);
  for(let i=1;i<callbacks.length;i++) {
    const a=callbacks[i-1], b=callbacks[i];
    if(b.sequence!==a.sequence+1) seqGap??=b.start_qpc;
    if(b.start_qpc<firstQpc||b.start_qpc>lastQpc) continue;
    if((b.flags&1)!==0) lock??=b.start_qpc;
    if(b.main_frames && a.main_frames) {
      const ms=(b.start_qpc-a.start_qpc)/10000;
      if(ms>thresholds.callbackGapMs) interval??={qpc:b.start_qpc,ms};
      const d=(b.playback_100ns-a.playback_100ns)/10000;
      if(d<0||d>thresholds.playbackGapMs) playback??={qpc:b.start_qpc,ms:d};
    }
  }
  if(seqGap!==null || packetGap!==null || flag!==null) return {classification:'capture_fault',seqGap,packetGap,flag,packets:packets.length,callbacks:callbacks.length};
  if(lock||interval||playback) return {classification:'timing_glitch',lock,interval,playback,packets:packets.length,callbacks:callbacks.length};
  return {classification:'clean',packets:packets.length,callbacks:callbacks.length,firstPacketQpc:packets[0].qpc_100ns};
}
function controlValue(type,at,amplitude,frame,ch,value) {
  if(type.startsWith('dropout'))return frame>=at&&frame<at+Number(type.slice(7))?0:value;
  if(type==='step'||type==='impulse')return frame===at&& (type==='step'||ch===0) ? value+amplitude:value;
  if(!type.startsWith('broadband'))throw Error(`Unknown control: ${type}`);
  const width=Number(type.slice(9));
  return frame>=at&&frame<at+width?value+amplitude*(frame%2?1:-1):value;
}
function injectFile(inFile,outFile,frame,type,amplitude) {
  const input=wav(inFile),out=Buffer.from(input.bytes);
  if(!Number.isInteger(frame)||frame<0||frame+144>=input.frames||!Number.isFinite(amplitude)||amplitude<=0)throw Error('Invalid control position or amplitude');
  const width=type.startsWith('dropout')?Number(type.slice(7)):type.startsWith('broadband')?Number(type.slice(9)):1;
  if(![1,4,8,16,24,32,48,96,144].includes(width))throw Error('Invalid control shape');
  for(let i=frame;i<frame+width;i++)for(let ch=0;ch<2;ch++){
    const value=controlValue(type,frame,amplitude,i,ch,input.sample(i,ch));
    out.writeFloatLE(value,input.data+i*8+ch*4);
  }
  fs.writeFileSync(outFile,out);
  console.log(JSON.stringify({inputSha256:sha(inFile),outputSha256:sha(outFile),frame,type,amplitude,rate:RATE}));
}
function controlClip(inFile,outFile,start,count,at,type,amplitude) {
  const input=wav(inFile);
  if(!Number.isInteger(start)||!Number.isInteger(count)||start<0||count<1||start+count>input.frames||at<start||at>=start+count)throw Error('Invalid clip range');
  const out=Buffer.alloc(44+count*4);
  out.write('RIFF',0);out.writeUInt32LE(out.length-8,4);out.write('WAVEfmt ',8);
  out.writeUInt32LE(16,16);out.writeUInt16LE(1,20);out.writeUInt16LE(2,22);
  out.writeUInt32LE(RATE,24);out.writeUInt32LE(RATE*4,28);out.writeUInt16LE(4,32);out.writeUInt16LE(16,34);
  out.write('data',36);out.writeUInt32LE(count*4,40);
  let peak=0;
  const fadeFrames=Math.min(7200,Math.floor(count/8));
  for(let i=0;i<count;i++)for(let ch=0;ch<2;ch++){
    const frame=start+i,ordinary=input.sample(frame,ch);
    const control=type==='clean'?ordinary:controlValue(type,at,amplitude,frame,ch,ordinary);
    const edge=Math.min(i,count-1-i);
    const fade=edge>=fadeFrames?1:Math.sin(Math.PI*edge/(2*fadeFrames))**2;
    const value=control*fade;
    peak=Math.max(peak,Math.abs(value));
    out.writeInt16LE(Math.max(-32768,Math.min(32767,Math.round(value*32767))),44+i*4+ch*2);
  }
  fs.writeFileSync(outFile,out);
  console.log(JSON.stringify({inputSha256:sha(inFile),outputSha256:sha(outFile),sourceStartFrame:start,frames:count,controlFrame:at,type,amplitude,peak}));
}
function calibrate(aFile,bFile,outFile,offlineManifestFile,validationFile) {
  const a=wav(aFile),b=wav(bFile),values=Object.fromEntries(keys.map(k=>[k,[]]));
  const localRows=[];
  const result=eachWindow(a,b,null,(frame,m,range)=>{
    for(const k of keys)values[k].push(m[k]);
    const second=Math.floor((frame-range.first)/RATE);
    (localRows[second]??=[]).push(m);
  });
  const stats={};
  for(const k of keys){const v=values[k].sort((a,b)=>a-b);stats[k]={median:v[Math.floor(v.length/2)],p999:v[Math.floor(v.length*0.999)],max:v.at(-1)};}
  const thresholds=Object.fromEntries(keys.map(k=>[k,stats[k].max*1.25]));
  const local=localRows.map(rows=>{
    const scale={};
    for(const k of keys){
      const v=rows.map(m=>m[k]).sort((x,y)=>x-y),median=v[Math.floor(v.length/2)];
      const deviations=v.map(x=>Math.abs(x-median)).sort((x,y)=>x-y);
      scale[k]=Math.max(v[Math.floor(v.length*.95)],median+6*deviations[Math.floor(deviations.length/2)],stats[k].median/4,1e-12);
    }
    return {windows:rows.length,scale,maxRawScore:Math.max(...rows.map(m=>featureScore(m,scale)))};
  });
  let validation=null;
  if(validationFile){
    const scores=[];
    const checked=eachWindow(wav(validationFile),b,null,(frame,m,range)=>{
      const second=Math.floor((frame-range.first)/RATE);
      if(local[second])scores.push(featureScore(m,local[second].scale));
    });
    validation={sha256:sha(validationFile),windows:scores.length,maxRawScore:scores.reduce((max,score)=>Math.max(max,score),0),alignment:checked.alignment};
  }
  const localCritical=Math.max(...local.map(s=>s.maxRawScore),validation?.maxRawScore??0)*1.25;
  const aC=continuity(a,result.active.first,result.active.last,null),bA=active(b),bC=continuity(b,bA.first,bA.last,null);
  const aTiming=callbackBaseline(aFile,result.active),bTiming=callbackBaseline(bFile,bA);
  thresholds.adjacentDelta=1.25*Math.max(aC.maxDelta,bC.maxDelta);
  thresholds.callbackGapMs=1.5*Math.max(aTiming.callbackGapMs.max,bTiming.callbackGapMs.max);
  thresholds.playbackGapMs=1.5*Math.max(aTiming.playbackGapMs.max,bTiming.playbackGapMs.max);
  const controls=[];
  for(const second of [50,120,200]) for(const amplitude of [0.00005,0.0001,0.0002,0.0005,0.001,0.002,0.005,0.01,0.02,0.05,0.1]) for(const type of ['step','impulse','broadband4','broadband8','broadband16','broadband32','dropout24','dropout48','dropout96','dropout144']) {
    const at=result.active.first+second*RATE+17;
    const inject=(frame,ch,value)=>controlValue(type,at,amplitude,frame,ch,value);
    const offset=result.alignment.offset,window=Math.floor(at/WINDOW)*WINDOW;
    const f=fit(a,b,window,offset), m=metrics(a,b,window,offset,f.gain,f.dc,inject);
    const c=type.startsWith('dropout')?continuity(a,at-1,at+145,inject):null;
    const score=Math.max(featureScore(m,thresholds),featureScore(m,local[second].scale)/localCritical);
    controls.push({second,amplitude,type,frame:at,detected:score>1||(c?.maxZero>=24),score,positionErrorFrames:Math.abs(window-at)});
  }
  let offlineCalibration=null;
  if(offlineManifestFile){
    const offline=offlineInput(offlineManifestFile);
    const values=Object.fromEntries(keys.map(k=>[k,[]]));
    const coverage=[];
    for(const file of [aFile,bFile,...(validationFile?[validationFile]:[])]){
      const scan=eachOfflineWindow(wav(file),offline,(_frame,m)=>{for(const k of keys)values[k].push(m[k]);});
      coverage.push({captureSha256:sha(file),...scan});
    }
    const stats={};
    for(const k of keys){const v=values[k].sort((a,b)=>a-b);stats[k]={median:v[Math.floor(v.length/2)],p999:v[Math.floor(v.length*.999)],max:v.at(-1)};}
    offlineCalibration={manifestSha256:offline.manifestSha256,referenceSha256:offline.manifest.sha256,coverage,stats,thresholds:Object.fromEntries(keys.map(k=>[k,stats[k].max*1.25]))};
  }
  const output={schema:2,rate:RATE,windowFrames:WINDOW,baseline:{aSha256:sha(aFile),bSha256:sha(bFile),alignedCorrelation:result.alignment.correlation,alignmentOffsetFrames:result.alignment.offset,activeFrames:{a:result.active.last-result.active.first,b:bA.last-bA.first},windows:values.rms.length,stats,continuity:{a:aC,b:bC},timing:{a:aTiming,b:bTiming}},thresholds,local:{criticalRawScore:localCritical,seconds:local,validation},offline:offlineCalibration,controls};
  fs.writeFileSync(outFile,JSON.stringify(output,null,2)+'\n');
  console.log(JSON.stringify({calibration:outFile,thresholds,controlHits:controls.filter(x=>x.detected).length,controls:controls.length,activeSeconds:(result.active.last-result.active.first)/RATE}));
}
function scan(file,refFile,calibrationFile,packetFile,callbackFile,outFile,offlineManifestFile) {
  const t0=process.hrtime.bigint(),target=wav(file),ref=wav(refFile),cal=JSON.parse(fs.readFileSync(calibrationFile));
  if(sha(refFile)!==cal.baseline.aSha256 && sha(refFile)!==cal.baseline.bSha256)throw Error('Reference is not a calibrated baseline');
  const offline=offlineManifestFile?offlineInput(offlineManifestFile):null;
  if(Boolean(offline)!==Boolean(cal.offline))throw Error('Offline calibration and scan inputs differ');
  if(offline&&offline.manifestSha256!==cal.offline.manifestSha256)throw Error('Offline manifest changed after calibration');
  const offlineWindows=new Map();
  const offlineCoverage=offline?eachOfflineWindow(target,offline,(frame,m,alignment)=>offlineWindows.set(frame,{m,alignment})):null;
  let first=null,maxScore=0,maxOfflineScore=0,candidates=0;
  const candidateDetails=[];
  const aligned=eachWindow(target,ref,null,(frame,m,range)=>{
    const second=Math.floor((frame-range.first)/RATE),local=cal.local.seconds[second];
    const globalScore=featureScore(m,cal.thresholds),localScore=local?featureScore(m,local.scale)/cal.local.criticalRawScore:0;
    const cleanScore=Math.max(globalScore,localScore),o=offlineWindows.get(frame);
    const offlineScore=o?featureScore(o.m,cal.offline.thresholds):0;
    const score=Math.max(cleanScore,Math.min(offlineScore,cleanScore*2));
    maxScore=Math.max(score,maxScore);maxOfflineScore=Math.max(offlineScore,maxOfflineScore);
    if(score>1){
      candidates++;
      candidateDetails.push({frame,score,cleanScore,globalScore,localScore,offlineScore,metrics:m});
      if(!first)first={classification:'pcm_transient',frame,score,cleanScore,globalScore,localScore,offlineScore,metrics:m,offlineMetrics:o?.m,offlineAlignment:o?.alignment,channelConsistency:m.impulseChannels[0]>cal.thresholds.impulse&&m.impulseChannels[1]>cal.thresholds.impulse?'both':'one_or_below'};
    }
  });
  const expected=active(ref), targetActiveFrames=aligned.active.last-aligned.active.first;
  if(Math.abs(targetActiveFrames-(expected.last-expected.first))>480)
    first={classification:'capture_fault',reason:'incomplete or changed ABA playback length',targetActiveFrames,expectedActiveFrames:expected.last-expected.first};
  const c=continuity(target,aligned.active.first,aligned.active.last,null);
  if(c.nonfinite!==null)first={classification:'capture_fault',frame:c.nonfinite,reason:'nonfinite sample'};
  else if(c.maxZero>=24)first={classification:'dropout',frame:c.firstGap,maxZeroFrames:c.maxZero};
  else if(c.maxDelta>cal.thresholds.adjacentDelta && !first) {
    const differences=[];
    for(let i=Math.max(aligned.active.first+1,c.deltaFrame-128);i<=Math.min(aligned.active.last,c.deltaFrame+128);i++)
      differences.push(Math.abs(target.sample(i,0)-target.sample(i-1,0)));
    differences.sort((a,b)=>a-b);
    const localMedian=differences[Math.floor(differences.length/2)];
    if(c.maxDelta>4*localMedian)first={classification:'pcm_transient',frame:c.deltaFrame,adjacentDelta:c.maxDelta,localMedian};
  }
  const cb=timing(packetFile,callbackFile,target.frames,aligned.active,cal.thresholds);
  if(cb.classification==='capture_fault')first={classification:'capture_fault',...cb};
  else if(cb.classification==='timing_glitch'&&!first)first={classification:'timing_glitch',...cb};
  if(first?.frame!==undefined) {
    const packets=csv(packetFile);
    let lo=0,hi=packets.length;
    while(lo<hi){const mid=(lo+hi)>>1;if(packets[mid].file_frame<=first.frame)lo=mid+1;else hi=mid;}
    const p=packets[Math.max(0,lo-1)];
    if(p&&first.frame<p.file_frame+p.frames)first.qpc100ns=p.qpc_100ns+Math.round((first.frame-p.file_frame)*1e7/RATE);
  }
  const output={classification:first?.classification||'clean',first,pcmCandidates:candidates,candidateDetails,maxScore,maxOfflineScore,offline:offline?{manifestSha256:offline.manifestSha256,referenceSha256:offline.manifest.sha256,coverage:offlineCoverage,matchedWindows:offlineWindows.size}:null,continuity:c,timing:cb,alignment:aligned.alignment,active:aligned.active,captureFrames:target.frames,analysisSeconds:Number(process.hrtime.bigint()-t0)/1e9,inputSha256:sha(file),calibrationSha256:sha(calibrationFile),packetSha256:sha(packetFile),callbackSha256:sha(callbackFile)};
  fs.writeFileSync(outFile,JSON.stringify(output,null,2)+'\n');
  console.log(JSON.stringify({classification:output.classification,frame:first?.frame,pcmCandidates:candidates,maxScore,analysisSeconds:output.analysisSeconds}));
}
function stateCsv(file) {
    const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(line => line && !line.startsWith('#'));
    if (!lines.length)
        throw Error('Empty CSV');
    const header = lines.shift().split(',');
    if (new Set(header).size !== header.length)
        throw Error('Duplicate CSV header');
    return {
        header, rows: lines.map((line, index) => {
            const values = line.split(',');
            if (values.length !== header.length)
                throw Error(`Malformed CSV row ${index + 2}`);
            return Object.fromEntries(header.map((name, i) => [name, values[i]]));
        })
    };
}
function stateInteger(value, name, nullable = false) {
    if (nullable && (value === '' || value === 'null' || value === null))
        return null;
    if (!/^\d+$/.test(String(value)))
        throw Error(`Invalid ${name}`);
    const result = Number(value);
    if (!Number.isSafeInteger(result))
        throw Error(`Unsafe ${name}`);
    return result;
}
function stateFile(base, descriptor, name) {
    if (!descriptor || typeof descriptor.file !== 'string' || !/^[0-9a-f]{64}$/.test(descriptor.sha256 || ''))
        throw Error(`Invalid ${name} descriptor`);
    const file = path.resolve(base, descriptor.file);
    if (!fs.existsSync(file) || sha(file) !== descriptor.sha256)
        throw Error(`${name} descriptor does not bind bytes`);
    return {
        file, sha256: descriptor.sha256
    };
}
function stateRoute(endpoint) {
    const tuple = value => ({
        endpoint_id: value?.endpoint_id, rate: value?.rate, channels: value?.channels, sample_format: value?.sample_format
    });
    const nonblank = value => typeof value === 'string' && value.trim().length > 0;
    if (endpoint?.schema !== 1 || !nonblank(endpoint.run_id) || !Number.isSafeInteger(endpoint.process_id) || endpoint.process_id <= 0 || !endpoint.stream || !endpoint.session?.before || !endpoint.session?.after)
        throw Error('Invalid endpoint receipt');
    const beforeReceipt = endpoint.session.before, afterReceipt = endpoint.session.after;
    const stream = tuple(endpoint.stream), before = tuple(beforeReceipt), after = tuple(afterReceipt);
    if (!nonblank(stream.endpoint_id) || stream.rate !== RATE || stream.channels !== 2 || stream.sample_format !== 'f32' || JSON.stringify(stream) !== JSON.stringify(before) || JSON.stringify(stream) !== JSON.stringify(after) || beforeReceipt.process_id !== endpoint.process_id || afterReceipt.process_id !== endpoint.process_id || !nonblank(beforeReceipt.session_id) || beforeReceipt.session_id !== afterReceipt.session_id)
        throw Error('Endpoint route observation mismatch');
    return {
        tuple: stream, hash: crypto.createHash('sha256').update(JSON.stringify(stream)).digest('hex')
    };
}
function statePackets(file, frames) {
    const parsed = stateCsv(file);
    for (const name of ['file_frame', 'qpc_100ns', 'frames'])
        if (!parsed.header.includes(name))
            throw Error(`Missing packet ${name}`);
    let expected = 0, lastQpc = -1, fault = null;
    const rows = parsed.rows.map((row, index) => {
        const packet = {
            file_frame: stateInteger(row.file_frame, `packet ${index} frame`), qpc_100ns: stateInteger(row.qpc_100ns, `packet ${index} QPC`), frames: stateInteger(row.frames, `packet ${index} frames`), flags: parsed.header.includes('flags') ? stateInteger(row.flags, `packet ${index} flags`) : 0
        };
        if (!packet.frames || packet.file_frame !== expected || packet.qpc_100ns <= lastQpc || packet.flags)
            fault ??= packet.file_frame;
        expected += packet.frames;
        lastQpc = packet.qpc_100ns;
        return packet;
    });
    if (!rows.length || expected !== frames)
        fault ??= expected;
    return {
        rows, fault
    };
}
function stateCallbacks(file) {
    const parsed = stateCsv(file), current = ['sequence', 'callback_qpc_100ns', 'playback_qpc_100ns', 'output_frames', 'engine_start', 'engine_end', 'paused', 'audition', 'render_lock_miss', 'trace_dropped'];
    const legacy = ['sequence', 'start_qpc', 'playback_100ns', 'main_frames', 'flags'];
    const currentSchema = current.every(name => parsed.header.includes(name)), legacySchema = legacy.every(name => parsed.header.includes(name));
    if (!currentSchema && !legacySchema)
        throw Error('Unsupported callback timing schema');
    let prior = -1;
    const rows = parsed.rows.map((row, index) => {
        const callback = currentSchema ? {
            sequence: stateInteger(row.sequence, `callback ${index} sequence`), callback_qpc_100ns: stateInteger(row.callback_qpc_100ns, `callback ${index} QPC`), playback_qpc_100ns: stateInteger(row.playback_qpc_100ns, `callback ${index} playback QPC`), output_frames: stateInteger(row.output_frames, `callback ${index} output frames`), engine_start: stateInteger(row.engine_start, `callback ${index} engine start`, true), engine_end: stateInteger(row.engine_end, `callback ${index} engine end`, true), paused: stateInteger(row.paused, `callback ${index} paused`), audition: stateInteger(row.audition, `callback ${index} audition`), render_lock_miss: stateInteger(row.render_lock_miss, `callback ${index} lock`), trace_dropped: stateInteger(row.trace_dropped, `callback ${index} trace dropped`)
        }
            : {
                sequence: stateInteger(row.sequence, `callback ${index} sequence`), callback_qpc_100ns: stateInteger(row.start_qpc, `callback ${index} QPC`), playback_qpc_100ns: stateInteger(row.playback_100ns, `callback ${index} playback QPC`), output_frames: stateInteger(row.main_frames, `callback ${index} output frames`), engine_start: null, engine_end: null, paused: null, audition: null, render_lock_miss: stateInteger(row.flags, `callback ${index} flags`) & 1, trace_dropped: 0
            };
        if (callback.sequence !== prior + 1 && index)
            callback.sequenceGap = true;
        prior = callback.sequence;
        return callback;
    });
    return {
        rows, currentSchema
    };
}
function stateFrameAtQpc(packets, qpc) {
    for (let i = 0; i < packets.length; i++) {
        const a = packets[i], b = packets[i + 1];
        const endQpc = b ? b.qpc_100ns : a.qpc_100ns + Math.round(a.frames * 1e7 / RATE), endFrame = b ? b.file_frame : a.file_frame + a.frames;
        if (qpc >= a.qpc_100ns && qpc <= endQpc)
            return a.file_frame + (qpc - a.qpc_100ns) * (endFrame - a.file_frame) / (endQpc - a.qpc_100ns);
    }
    return null;
}
function stateRangeKind(range) {
    return range.kind === 'audio' ? 'audio' : range.kind === 'intentional' ? 'intentional' : 'unclassified';
}
function stateZero(wave, start, end) {
    for (let frame = start; frame < end; frame++)
        for (let ch = 0; ch < 2; ch++)
            if (wave.sample(frame, ch) !== 0)
                return false;
    return true;
}
function stateOrigin(originFile, capture, packetsFile, callbacksFile) {
    const origin = JSON.parse(fs.readFileSync(originFile, 'utf8'));
    const files = Object.fromEntries(['raw_capture', 'raw_packets', 'raw_callbacks'].map(name => [name, stateFile(path.dirname(originFile), origin[name], `origin ${name}`)]));
    const rawCapture = wav(files.raw_capture.file), start = origin.start_frame, end = origin.end_frame;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > rawCapture.frames || end - start !== capture.frames)
        throw Error('Invalid origin crop bounds');
    const rawPcm = rawCapture.bytes.subarray(rawCapture.data + start * 8, rawCapture.data + end * 8);
    const croppedPcm = capture.bytes.subarray(capture.data, capture.data + capture.frames * 8);
    if (!rawPcm.equals(croppedPcm))
        throw Error('Origin capture does not bind cropped PCM');
    const rawPackets = statePackets(files.raw_packets.file, rawCapture.frames), croppedPackets = statePackets(packetsFile, capture.frames);
    const expectedPackets = rawPackets.rows.filter(row => row.file_frame < end && row.file_frame + row.frames > start).map(row => {
        const first = Math.max(start, row.file_frame), last = Math.min(end, row.file_frame + row.frames);
        return { file_frame: first - start, qpc_100ns: row.qpc_100ns + Math.round((first - row.file_frame) * 1e7 / RATE), frames: last - first, flags: row.flags };
    });
    if (rawPackets.fault !== null || croppedPackets.fault !== null || JSON.stringify(croppedPackets.rows) !== JSON.stringify(expectedPackets))
        throw Error('Origin packets do not bind cropped timestamps and frames');
    const cropped = stateCsv(callbacksFile), raw = stateCsv(files.raw_callbacks.file);
    const unchanged = JSON.stringify(cropped.header) === JSON.stringify(raw.header) && raw.rows.some((_, startRow) => cropped.rows.every((row, index) => JSON.stringify(row) === JSON.stringify(raw.rows[startRow + index])));
    if (!unchanged)
        throw Error('Origin callbacks do not bind cropped rows');
    return files;
}
function stateLoad(inputFile) {
    const base = path.dirname(inputFile), state = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
    if (state.schema !== 1 || !Array.isArray(state.ranges) || typeof state.routehash !== 'string' || !state.routehash)
        throw Error('Invalid state schema');
    const files = Object.fromEntries(['capture', 'reference', 'packets', 'callbacks', 'endpoint_receipt'].map(name => [name, stateFile(base, state[name], name)]));
    if (state.origin !== undefined)
        files.origin = stateFile(base, state.origin, 'origin');
    const capture = wav(files.capture.file), reference = wav(files.reference.file), packets = statePackets(files.packets.file, capture.frames), callbacks = stateCallbacks(files.callbacks.file);
    const origin = files.origin ? stateOrigin(files.origin.file, capture, files.packets.file, files.callbacks.file) : null;
    if (reference.frames < 1)
        throw Error('Empty state reference');
    const endpoint = JSON.parse(fs.readFileSync(files.endpoint_receipt.file, 'utf8'));
    const route = stateRoute(endpoint);
    if (state.routehash !== route.hash)
        throw Error('State route hash does not bind endpoint receipt');
    const issues = [], ranges = [];
    let cursor = 0;
    for (const [index, raw] of state.ranges.entries()) {
        const range = {
            ...raw, start: raw.start, end: raw.end, kind: stateRangeKind(raw)
        };
        if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start !== cursor || range.end <= range.start || range.end > capture.frames)
            issues.push(`range_${index}_partition`);
        cursor = range.end;
        if (range.kind === 'audio' && (!Number.isSafeInteger(range.reference_start) || range.reference_start < 0 || range.reference_start + (range.end - range.start) > reference.frames)) {
            range.kind = 'unclassified';
            issues.push(`range_${index}_reference`);
        }
        if (range.kind === 'intentional' && !['paused', 'diagnostic_gate', 'capture_preroll', 'capture_postroll'].includes(range.reason)) {
            range.kind = 'unclassified';
            issues.push(`range_${index}_reason`);
        }
        ranges.push(range);
    }
    if (cursor !== capture.frames)
        issues.push('partition_end');
    return {
        state, stateSha256: sha(inputFile), files, capture, reference, packets, callbacks, origin, endpoint, route, ranges, issues
    };
}
function stateTiming(input, thresholds) {
    const faults = [], incomplete = [], glitches = [], rows = input.callbacks.rows, packets = input.packets.rows;
    if (input.packets.fault !== null)
        faults.push({
            code: 'packet_coverage', frame: input.packets.fault
        });
    if (!rows.length)
        incomplete.push({
            code: 'callbacks_missing'
        });
    let maxGap = 0, maxPlaybackGap = 0;
    for (const [index, row] of rows.entries()) {
        if (row.sequenceGap)
            faults.push({
                code: 'callback_sequence_gap', sequence: row.sequence
            });
        if (row.render_lock_miss)
            faults.push({
                code: 'render_lock_miss', sequence: row.sequence
            });
        if (row.trace_dropped)
            faults.push({
                code: 'trace_dropped', sequence: row.sequence
            });
        if (!input.callbacks.currentSchema)
            incomplete.push({
                code: 'legacy_callback_schema'
            });
        if (index) {
            const previous = rows[index - 1], gap = (row.callback_qpc_100ns - previous.callback_qpc_100ns) / 10000, playback = (row.playback_qpc_100ns - previous.playback_qpc_100ns) / 10000;
            if (previous.engine_end !== null && row.engine_start !== null && previous.engine_end !== row.engine_start)
                faults.push({ code: 'engine_frame_gap', sequence: row.sequence });
            maxGap = Math.max(maxGap, gap);
            maxPlaybackGap = Math.max(maxPlaybackGap, playback);
            if (thresholds && (gap > thresholds.callbackGapMs || playback < 0 || playback > thresholds.playbackGapMs))
                glitches.push({
                    code: 'callback_timing', sequence: row.sequence, gap, playback
                });
        }
    }
    return {
        classification: faults.length ? 'capture_fault' : incomplete.length ? 'incomplete' : glitches.length ? 'timing_glitch' : 'clean', faults, incomplete, glitches, maxGapMs: maxGap, maxPlaybackGapMs: maxPlaybackGap, packets: packets.length, callbacks: rows.length
    };
}
function stateValidateRanges(input) {
    const problems = [...input.issues], rows = input.callbacks.rows, first = rows[0], last = rows.at(-1);
    const interval = row => {
        const start = stateFrameAtQpc(input.packets.rows, row.playback_qpc_100ns);
        return start === null ? null : {
            start, end: start + row.output_frames
        };
    };
    const qpcAtFrame = frame => {
        const packet = input.packets.rows.find(row => frame >= row.file_frame && frame <= row.file_frame + row.frames);
        return packet ? packet.qpc_100ns + (frame - packet.file_frame) * 1e7 / RATE : null;
    };
    for (const [index, range] of input.ranges.entries()) {
        if (range.kind === 'unclassified')
            continue;
        const preroll = range.kind === 'intentional' && range.reason === 'capture_preroll';
        const postroll = range.kind === 'intentional' && range.reason === 'capture_postroll';
        if (preroll || postroll) {
            if (!stateZero(input.capture, range.start, range.end))
                problems.push(`range_${index}_intentional_pcm`);
            if (preroll && (!first || range.end > stateFrameAtQpc(input.packets.rows, first.playback_qpc_100ns) + 1))
                problems.push(`range_${index}_preroll`);
            if (postroll && (!last || range.start < stateFrameAtQpc(input.packets.rows, last.playback_qpc_100ns) + last.output_frames - 1))
                problems.push(`range_${index}_postroll`);
            continue;
        }
        const selected = rows.filter(row => row.sequence >= range.first_sequence && row.sequence <= range.last_sequence);
        if (!Number.isSafeInteger(range.first_sequence) || !Number.isSafeInteger(range.last_sequence) || !selected.length || selected[0].sequence !== range.first_sequence || selected.at(-1).sequence !== range.last_sequence) {
            problems.push(`range_${index}_callbacks`);
            continue;
        }
        if (range.kind === 'audio') {
            const expected = range.last_sequence - range.first_sequence + 1, outputFrames = selected.reduce((total, row) => total + row.output_frames, 0);
            if (!input.callbacks.currentSchema || selected.length !== expected || selected.some((row, offset) => row.sequence !== range.first_sequence + offset || row.output_frames <= 0 || row.paused !== 0 || row.audition !== 0 || row.render_lock_miss !== 0 || row.trace_dropped !== 0 || row.engine_start === null || row.engine_end === null || row.engine_end - row.engine_start !== row.output_frames) || outputFrames < range.end - range.start)
                problems.push(`range_${index}_audio_state`);
            const startQpc = qpcAtFrame(range.start), endQpc = qpcAtFrame(range.end), final = selected.at(-1);
            if (startQpc === null || endQpc === null || selected[0].playback_qpc_100ns > startQpc || final.playback_qpc_100ns + final.output_frames * 1e7 / RATE < endQpc)
                problems.push(`range_${index}_callback_bracket`);
            continue;
        }
        const overlapping = rows.filter(row => {
            const span = interval(row);
            return span && span.start < range.end && span.end > range.start;
        });
        if (overlapping.some(row => row.sequence < range.first_sequence || row.sequence > range.last_sequence))
            problems.push(`range_${index}_callback_span`);
        let covered = range.start;
        for (const row of selected) {
            const span = interval(row);
            if (!span) {
                problems.push(`range_${index}_qpc`);
                continue;
            }
            if (span.start > covered + 1)
                problems.push(`range_${index}_callback_span`);
            covered = Math.max(covered, span.end);
            if (range.kind === 'intentional' && (!input.callbacks.currentSchema || row.paused !== 1 || row.audition !== 0 || row.render_lock_miss !== 0 || row.trace_dropped !== 0 || (row.engine_start === null) !== (row.engine_end === null) || (row.engine_start !== null && row.engine_start !== row.engine_end)))
                problems.push(`range_${index}_intentional_state`);
        }
        if (covered < range.end - 1)
            problems.push(`range_${index}_callback_span`);
        if (range.kind === 'intentional' && !stateZero(input.capture, range.start, range.end))
            problems.push(`range_${index}_intentional_pcm`);
    }
    return problems;
}
function stateFit(target, reference, range) {
    let sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0;
    for (let frame = range.start; frame < range.end; frame++)
        for (let ch = 0; ch < 2; ch++) {
            const x = reference.sample(range.reference_start + frame - range.start, ch), y = target.sample(frame, ch);
            if (Math.abs(x) <= ACTIVE_LEVEL || Math.abs(y) <= ACTIVE_LEVEL)
                continue;
            sx += x;
            sy += y;
            sxx += x * x;
            sxy += x * y;
            n++;
        }
    const gain = (sxy - sx * sy / n) / (sxx - sx * sx / n);
    return {
        gain, dc: (sy - gain * sx) / n
    };
}
function stateMetrics(target, reference, range, start, count, fitResult) {
    const values = [], curves = [];
    let sum = 0, peak = 0, difference = 0, high = 0, impulse = 0, diffN = 0, highN = 0;
    for (let i = 0; i < count; i++)
        for (let ch = 0; ch < 2; ch++) {
            const residual = target.sample(start + i, ch) - (fitResult.gain * reference.sample(range.reference_start + start + i - range.start, ch) + fitResult.dc);
            values.push(residual);
            sum += residual * residual;
            peak = Math.max(peak, Math.abs(residual));
        }
    for (let i = 0; i < count; i++)
        for (let ch = 0; ch < 2; ch++) {
            const at = (i * 2) + ch, previous = i ? values[at - 2] : values[at], next = i + 1 < count ? values[at + 2] : values[at], curve = Math.abs(previous - 2 * values[at] + next);
            curves.push(curve);
            impulse = Math.max(impulse, curve);
            if (i > 1 && i + 2 < count) {
                difference += (values[at] - values[at - 2]) ** 2;
                diffN++;
                high += (values[at] - (values[at - 4] + values[at - 2] + values[at] + values[at + 2] + values[at + 4]) / 5) ** 2;
                highN++;
            }
        }
    const result = {
        rms: Math.sqrt(sum / Math.max(1, count * 2)), peak, difference: Math.sqrt(difference / Math.max(1, diffN)), high: Math.sqrt(high / Math.max(1, highN)), impulse
    };
    for (const width of [8, 32]) {
        let short = 0, residual = 0;
        for (let offset = 0; offset < count; offset += 8) {
            const length = Math.min(width, count - offset);
            for (let ch = 0; ch < 2; ch++) {
                let a = 0, b = 0;
                for (let i = 0; i < length; i++) {
                    a += curves[(offset + i) * 2 + ch] ** 2;
                    b += values[(offset + i) * 2 + ch] ** 2;
                }
                short = Math.max(short, Math.sqrt(a / length));
                residual = Math.max(residual, Math.sqrt(b / length));
            }
        }
        result[`short${width}`] = short;
        result[`residual${width}`] = residual;
    }
    return result;
}
function stateWindows(input, visit, validateFit = true) {
    for (const range of input.ranges)
        if (range.kind === 'audio') {
            const fitResult = stateFit(input.capture, input.reference, range);
            if (!Number.isFinite(fitResult.gain) || !Number.isFinite(fitResult.dc) || (validateFit && (Math.abs(fitResult.gain - 1) > 0.05 || Math.abs(fitResult.dc) > 0.05)))
                throw Error(`Gain/DC mismatch at ${range.start}`);
            for (let start = range.start; start < range.end; start += WINDOW)
                visit(range, start, Math.min(WINDOW, range.end - start), stateMetrics(input.capture, input.reference, range, start, Math.min(WINDOW, range.end - start), { gain: 1, dc: 0 }), fitResult);
        }
}
function stateThresholds(stats) {
    return Object.fromEntries(keys.map(key => [key, Math.max(stats[key].max * 1.25, 1e-12)]));
}
function stateContinuity(wave, ranges) {
    let first = null, maxZero = 0, nonfinite = null, maxDelta = 0, zero = 0, previousEnd = null;
    for (const range of ranges) {
        if (range.kind !== 'audio') {
            zero = 0;
            previousEnd = null;
            continue;
        }
        if (previousEnd !== range.start)
            zero = 0;
        for (let frame = range.start; frame < range.end; frame++) {
            let both = true;
            for (let ch = 0; ch < 2; ch++) {
                const value = wave.sample(frame, ch);
                if (!Number.isFinite(value))
                    nonfinite ??= frame;
                if (Math.abs(value) > 1e-6)
                    both = false;
                if (frame > 0)
                    maxDelta = Math.max(maxDelta, Math.abs(value - wave.sample(frame - 1, ch)));
            }
            if (both) {
                zero++;
                if (zero >= 24)
                    first ??= frame - zero + 1;
                maxZero = Math.max(maxZero, zero);
            }
            else
                zero = 0;
        }
        previousEnd = range.end;
    }
    for (let frame = 0; frame < wave.frames; frame++)
        for (let ch = 0; ch < 2; ch++)
            if (!Number.isFinite(wave.sample(frame, ch)))
                nonfinite ??= frame;
    return {
        firstGap: first, maxZero, nonfinite, maxDelta
    };
}
function calibrateState(aFile, bFile, outFile) {
    const a = stateLoad(aFile), b = stateLoad(bFile);
    if (a.route.hash !== b.route.hash)
        throw Error('Negative routes differ');
    if (!a.endpoint.run_id || !b.endpoint.run_id || a.endpoint.run_id === b.endpoint.run_id || a.endpoint.process_id === b.endpoint.process_id)
        throw Error('Negative captures lack independent endpoint receipts');
    if (JSON.stringify(a.route.tuple) !== JSON.stringify(b.route.tuple))
        throw Error('Negative endpoint routes are not stable');
    const values = Object.fromEntries(keys.map(key => [key, []]));
    for (const input of [a, b]) {
        const timing = stateTiming(input);
        if (timing.classification !== 'clean' || stateValidateRanges(input).length)
            throw Error('Negative state is not complete');
        const continuity = stateContinuity(input.capture, input.ranges);
        if (continuity.nonfinite !== null || continuity.firstGap !== null)
            throw Error('Negative PCM continuity is not clean');
        let windows = 0;
        stateWindows(input, (_range, _start, _count, metrics) => {
            windows++;
            keys.forEach(key => values[key].push(metrics[key]));
        });
        if (!windows)
            throw Error('Negative state has no audio windows');
    }
    const stats = Object.fromEntries(keys.map(key => {
        const value = values[key].sort((x, y) => x - y);
        return [key, {
                median: value[Math.floor(value.length / 2)], p999: value[Math.floor(value.length * .999)], max: value.at(-1)
            }
        ];
    }));
    const timingA = stateTiming(a), timingB = stateTiming(b);
    const continuityA = stateContinuity(a.capture, a.ranges), continuityB = stateContinuity(b.capture, b.ranges);
    const thresholds = {
        ...stateThresholds(stats), adjacentDelta: Math.max(continuityA.maxDelta, continuityB.maxDelta) * 1.25, callbackGapMs: Math.max(timingA.maxGapMs, timingB.maxGapMs) * 1.5, playbackGapMs: Math.max(timingA.maxPlaybackGapMs, timingB.maxPlaybackGapMs) * 1.5
    };
    if (!Object.values(stats).every(stat => Object.values(stat).every(Number.isFinite)) || !Object.values(thresholds).every(value => Number.isFinite(value) && value > 0))
        throw Error('Negative calibration statistics are invalid');
    const output = {
        schema: 3, rate: RATE, windowFrames: WINDOW,
        baseline: {
            aSha256: a.files.reference.sha256, bSha256: b.files.reference.sha256
        },
        routehash: a.route.hash, stats,
        thresholds,
        timing: {
            a: timingA, b: timingB
        },
        provenance: {
            detectorSha256: sha(__filename),
            a: {
                stateSha256: a.stateSha256, capture: a.files.capture, reference: a.files.reference, packets: a.files.packets, callbacks: a.files.callbacks, endpoint_receipt: a.files.endpoint_receipt, origin: a.files.origin, runId: a.endpoint.run_id, processId: a.endpoint.process_id
            },
            b: {
                stateSha256: b.stateSha256, capture: b.files.capture, reference: b.files.reference, packets: b.files.packets, callbacks: b.files.callbacks, endpoint_receipt: b.files.endpoint_receipt, origin: b.files.origin, runId: b.endpoint.run_id, processId: b.endpoint.process_id
            }
        }
    };
    fs.writeFileSync(outFile, JSON.stringify(output, null, 2) + '\n');
    console.log(JSON.stringify({
        classification: 'calibrated', calibration: outFile, routehash: output.routehash
    }));
}
function scanState(stateFile, calibrationFile, outFile) {
    const input = stateLoad(stateFile), cal = JSON.parse(fs.readFileSync(calibrationFile, 'utf8'));
    if (cal.schema !== 3 || cal.rate !== RATE || cal.windowFrames !== WINDOW)
        throw Error('Unsupported state calibration');
    if (cal.provenance?.detectorSha256 !== sha(__filename))
        throw Error('Calibration detector revision mismatch');
    if (cal.routehash !== input.route.hash)
        throw Error('Calibration route mismatch');
    if (!cal.thresholds || !keys.every(key => Number.isFinite(cal.thresholds[key]) && cal.thresholds[key] > 0) || !['adjacentDelta', 'callbackGapMs', 'playbackGapMs'].every(key => Number.isFinite(cal.thresholds[key]) && cal.thresholds[key] > 0))
        throw Error('Calibration thresholds are invalid');
    const timing = stateTiming(input, cal.thresholds), problems = stateValidateRanges(input), stateFault = problems.some(problem => problem.endsWith('_intentional_state') || problem.endsWith('_intentional_pcm')), coverageRanges = input.ranges.map(range => ({
        start: range.start, end: range.end, kind: range.kind
    }));
    let first = null, candidates = 0, maxScore = 0;
    const candidateFrames = [];
    const noAudio = !input.ranges.some(range => range.kind === 'audio');
    const classified = problems.length || timing.classification === 'incomplete' || noAudio;
    if (!classified)
        stateWindows(input, (_range, start, count, metrics) => {
            const score = featureScore(metrics, cal.thresholds);
            maxScore = Math.max(maxScore, score);
            if (score > 1) {
                candidates++;
                candidateFrames.push(start);
                first ??= {
                    classification: 'pcm_transient', frame: start, frames: count, score, metrics
                };
            }
        });
    const continuity = stateContinuity(input.capture, input.ranges);
    if (continuity.nonfinite !== null)
        first = {
            classification: 'capture_fault', frame: continuity.nonfinite, reason: 'nonfinite_sample'
        };
    else if (continuity.firstGap !== null)
        first = {
            classification: 'dropout', frame: continuity.firstGap, maxZeroFrames: continuity.maxZero
        };
    if (timing.classification === 'capture_fault' || stateFault)
        first = {
            classification: 'capture_fault', ...(stateFault ? {
                problems
            }
                : timing)
        };
    else if (timing.classification === 'timing_glitch' && !first)
        first = {
            classification: 'timing_glitch', ...timing
        };
    const unclassified = coverageRanges.filter(range => range.kind === 'unclassified').length + (problems.length ? 1 : 0) + (noAudio ? 1 : 0), complete = !unclassified && timing.classification !== 'incomplete';
    const classification = timing.classification === 'capture_fault' || stateFault ? 'capture_fault' : !complete ? 'incomplete' : first?.classification || 'clean';
    const output = {
        schema: 1, classification, first: classification === 'incomplete' ? {
            classification: 'incomplete', problems
        }
            : first, captureFrames: input.capture.frames, inputSha256: input.files.capture.sha256, calibrationSha256: sha(calibrationFile), detectorSha256: sha(__filename), packetSha256: input.files.packets.sha256, callbackSha256: input.files.callbacks.sha256, endpointReceiptSha256: input.files.endpoint_receipt.sha256, referenceSha256: input.files.reference.sha256, coverage: {
            total_windows: 0, audio_windows: 0, intentional_windows: 0, unclassified_windows: unclassified, complete, ranges: coverageRanges
        },
        residual: {
            maxScore, candidates, candidateFrames
        },
        continuity, timing
    };
    for (const range of input.ranges) {
        if (range.kind === 'audio')
            output.coverage.audio_windows++;
        else if (range.kind === 'intentional')
            output.coverage.intentional_windows++;
    }
    output.coverage.total_windows = output.coverage.audio_windows + output.coverage.intentional_windows;
    fs.writeFileSync(outFile, JSON.stringify(output, null, 2) + '\n');
    console.log(JSON.stringify({
        classification, frame: output.first?.frame, complete
    }));
}
function compare(captureManifestFile,replayFile,scanFile,outFile) {
  const { compareEvidence } = require('./audio-anomaly-comparison.cjs');
  const output=compareEvidence({captureManifestPath:captureManifestFile,replayPath:replayFile,scanPath:scanFile});
  fs.writeFileSync(outFile,JSON.stringify(output,null,2)+'\n');
  console.log(JSON.stringify({classification:output.classification,soundQuality:output.soundQuality,comparable:output.comparable,findings:output.findings.length}));
}
module.exports={RATE,wav,localOffset};
if(require.main===module){
  const [mode,...args]=process.argv.slice(2);
  if(mode==='calibrate-state'&&args.length===3)calibrateState(...args);
  else if(mode==='scan-state'&&args.length===3)scanState(...args);
  else if(mode==='calibrate'&&(args.length===4||args.length===5))calibrate(...args);
  else if(mode==='scan'&&args.length===7)scan(...args);
  else if(mode==='compare'&&args.length===4)compare(...args);
  else if(mode==='inject'&&args.length===5)injectFile(args[0],args[1],Number(args[2]),args[3],Number(args[4]));
  else if(mode==='clip'&&args.length===7)controlClip(args[0],args[1],Number(args[2]),Number(args[3]),Number(args[4]),args[5],Number(args[6]));
  else {console.error('Usage: node detect.cjs calibrate-state negative-a-state.json negative-b-state.json calibration.json | scan-state state.json calibration.json result.json | calibrate clean-a.wav clean-b.wav calibration.json offline-manifest.json [validation-clean.wav] | scan capture.wav clean.wav calibration.json packets.csv callbacks.csv result.json offline-manifest.json | compare capture-manifest.json replay.json scan-result.json|- result.json | inject input.wav output.wav frame type amplitude | clip input.wav output.wav startFrame frameCount controlFrame type amplitude');process.exitCode=2;}
}
