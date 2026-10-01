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
  return Math.max(
    Math.min(m.rms/t.rms,Math.max(m.difference/t.difference,m.high/t.high)),
    Math.min(m.peak/t.peak,m.high/t.high),
    Math.min(m.impulse/t.impulse,m.short8/t.short8),
    Math.min(m.short8/t.short8,m.short32/t.short32),
    Math.min(m.residual8/t.residual8,m.short8/t.short8)
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
  const output={classification:first?.classification||'clean',first,pcmCandidates:candidates,candidateDetails,maxScore,maxOfflineScore,offline:offline?{manifestSha256:offline.manifestSha256,referenceSha256:offline.manifest.sha256,coverage:offlineCoverage,matchedWindows:offlineWindows.size}:null,continuity:c,timing:cb,alignment:aligned.alignment,active:aligned.active,captureFrames:target.frames,analysisSeconds:Number(process.hrtime.bigint()-t0)/1e9,inputSha256:sha(file)};
  fs.writeFileSync(outFile,JSON.stringify(output,null,2)+'\n');
  console.log(JSON.stringify({classification:output.classification,frame:first?.frame,pcmCandidates:candidates,maxScore,analysisSeconds:output.analysisSeconds}));
}
const [mode,...args]=process.argv.slice(2);
if(mode==='calibrate'&&(args.length===4||args.length===5))calibrate(...args);
else if(mode==='scan'&&args.length===7)scan(...args);
else if(mode==='inject'&&args.length===5)injectFile(args[0],args[1],Number(args[2]),args[3],Number(args[4]));
else if(mode==='clip'&&args.length===7)controlClip(args[0],args[1],Number(args[2]),Number(args[3]),Number(args[4]),args[5],Number(args[6]));
else {console.error('Usage: node detect.cjs calibrate clean-a.wav clean-b.wav calibration.json offline-manifest.json [validation-clean.wav] | scan capture.wav clean.wav calibration.json packets.csv callbacks.csv result.json offline-manifest.json | inject input.wav output.wav frame type amplitude | clip input.wav output.wav startFrame frameCount controlFrame type amplitude');process.exitCode=2;}
