// Synthetic IPC fixture for browser acceptance only; native tests verify persistence.
import { installIpcForTesting } from '/src/lib/tauri.ts';
const copy=value=>value==null?value:JSON.parse(JSON.stringify(value));
const row=(name,hash,extra={})=>({path:`/synthetic/${name}.mp3`,content_hash:hash,title:`Synthetic ${name}`,artist:'Fixture Artist',duration_secs:180,analyzed:true,is_funkot:true,label:null,intro_bars:16,outro_bars:16,outro_structure_bars:16,intro_manual:false,outro_manual:false,intro_low_confidence:false,outro_low_confidence:false,played_at_ms:null,added_order:1,...extra});
const rows=[row('Alpha','a'),row('Beta','b',{is_funkot:false}),row('Gamma','c',{analyzed:false}),row('Duplicate','a'),row('Unresolved',null)];
const state=(r)=>({content_hash:r.content_hash,effective:r.content_hash?[{key:'year:2023',kind:'year',value:'2023',origin:'embedded'},{key:'genre:Funkot'.toLowerCase(),kind:'genre',value:'Funkot',origin:'embedded'}]:[],manual:{year:{mode:'auto'},manual_additions:[],suppressed_auto_tags:[]},auto_year:r.content_hash?2023:null,year_status:r.content_hash?'resolved':'missing',metadata_status:r.content_hash?'ready':'pending',candidates:r.content_hash?[{raw_key:'TYER',raw_value:'2023',semantic:'recording',rank:0},{raw_key:'TDRL',raw_value:'2024',semantic:'release',rank:2}]:[],diagnostics:[]});
window.fixture={rows,snapshot:{revision:'fixture:1',ready:true,store_status:'ready',tracks:Object.fromEntries(rows.map(r=>[r.path,state(r)]))},calls:[],listeners:{},fail:null,delay:0};
window.fixture.resetFilters=async()=>{
  const f=window.fixture;
  f.rows=[row('Alpha','a'),row('Beta','b',{is_funkot:false}),row('Gamma','c'),row('Delta','d'),row('Epsilon','e'),row('Pending','p'),row('Error','x')];
  const specs=[['2024','Funkot','配信候補'],['2023','Funkot','練習'],['2024','Pop','配信候補'],[null,'Funkot',null],[null,null,null],[null,null,null],[null,null,null]];
  f.snapshot={revision:'fixture:100',ready:true,store_status:'ready',tracks:Object.fromEntries(f.rows.map((r,i)=>{
    const s=state(r),[year,genre,custom]=specs[i];
    s.effective=[['year',year],['genre',genre],['custom',custom]].filter(([,value])=>value).map(([kind,value])=>({key:`${kind}:${value.replace(/[A-Z]/g,c=>c.toLowerCase())}`,kind,value,origin:kind==='custom'?'manual':'embedded'}));
    s.auto_year=year?Number(year):null;s.year_status=year?'resolved':'missing';
    s.candidates=year?[{raw_key:'TYER',raw_value:year,semantic:'recording',rank:0}]:i===4?[{raw_key:'©day',raw_value:'2020',semantic:'release',rank:2}]:[];
    s.metadata_status=i===5?'pending':i===6?'error':'ready';s.diagnostics=i===6?['metadata_probe_failed']:[];
    return [r.path,s];
  }))};
  await f.store.doRefreshLibrary();
};
installIpcForTesting({
  listen:async(name,handler)=>{window.fixture.listeners[name]=handler;return ()=>{};},
  invoke:async(command,args)=>{
    const f=window.fixture;f.calls.push({command,args:copy(args)});
    switch(command){
      case 'get_locale':return 'en';
      case 'app_dirs':return {music_dir:'/synthetic',cache_dir:'/fixture-cache',data_dir:'/fixture-data',music_dir_custom:'/synthetic',music_dir_unavailable:false,music_dir_needed:false,music_dir_configurable:true};
      case 'take_pending_import':return {tracks:0,skipped:0,failed:0,in_flight:false};
      case 'get_allow_non_funkot':case 'get_labeling_mode':return false;
      case 'player_state':return {phase:'idle',paused:false,now_playing:null,previous:null,last_transition:null,auditioning:false,audition_from:null,audition_to:null,position_secs:null,duration_secs:null,history_revision:0};
      case 'queue_state':return {reserved:null,pending:[],in_flight:[],reserved_swappable:false,reserved_prepared:false,transition_in_secs:null,folder_pos:0,folder_len:0};
      case 'list_play_history':return {log:[],tracks:[],log_total:0};
      case 'list_new_arrivals':return [{path:rows[0].path,hash:'a'}];
      case 'refresh_library':return copy(f.rows);
      case 'list_track_tags': { const result=copy(f.snapshot); if(f.listDelay)await new Promise(r=>setTimeout(r,f.listDelay)); if(f.failRead)throw {code:'persist_failed'}; return result; }
      case 'update_track_tags':{
        if(f.delay)await new Promise(r=>setTimeout(r,f.delay));
        if(f.fail)throw {code:f.fail,message:'Synthetic failure'};
        const request=args.request;
        if(request.expected_revision!==f.snapshot.revision)throw {code:'stale_revision',message:'Synthetic stale revision'};
        const hashes=new Set(request.targets.map(t=>t.expected_hash));
        if(!request.patch.year_change&&!request.patch.add?.length&&!request.patch.remove?.length)return {snapshot:copy(f.snapshot),changed:0,no_op:hashes.size};
        for(const track of Object.values(f.snapshot.tracks))if(hashes.has(track.content_hash)){
          const patch=request.patch;
          if(patch.year_change){track.manual.year=copy(patch.year_change);track.effective=track.effective.filter(t=>t.kind!=='year');const y=patch.year_change.mode==='set'?patch.year_change.value:patch.year_change.mode==='auto'?track.auto_year:null;if(y)track.effective.push({key:`year:${y}`,kind:'year',value:String(y),origin:patch.year_change.mode==='set'?'manual':'embedded'});}
          for(const removed of patch.remove??[]){track.effective=track.effective.filter(t=>!(t.kind===removed.kind&&t.value===removed.value));track.manual.suppressed_auto_tags.push(copy(removed));}
          for(const added of patch.add??[]){track.manual.manual_additions.push(copy(added));track.manual.suppressed_auto_tags=track.manual.suppressed_auto_tags.filter(t=>!(t.kind===added.kind&&t.value===added.value));const key=`${added.kind}:${added.value.trim().normalize('NFC').replace(/[A-Z]/g,c=>c.toLowerCase())}`;if(!track.effective.some(t=>t.key===key))track.effective.push({...added,key,origin:'manual'});}
        }
        f.snapshot.revision=`fixture:${Number(f.snapshot.revision.split(':')[1])+1}`;
        return {snapshot:copy(f.snapshot),changed:hashes.size,no_op:0};
      }
      default:throw new Error(`Unexpected fixture command ${command}`);
    }
  }
});
await import('/src/main.ts');
window.fixture.store=(await import('/src/lib/state.svelte.ts')).store;
window.fixture.i18n=(await import('/src/lib/i18n.svelte.ts')).i18n;
window.fixture.ui=(await import('/src/lib/ui.svelte.ts')).ui;
