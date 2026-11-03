use super::*;
use std::cell::RefCell;
use std::sync::Once;

thread_local! {
    static CALLBACK: RefCell<Option<(Arc<Mutex<RenderState>>, Arc<AtomicBool>)>> = const { RefCell::new(None) };
}

struct CallbackProbe;

impl log::Log for CallbackProbe {
    fn enabled(&self, _: &log::Metadata<'_>) -> bool { true }

    fn log(&self, record: &log::Record<'_>) {
        if !record.args().to_string().starts_with("manual next plan:") { return; }
        CALLBACK.with(|slot| {
            let slot = slot.borrow();
            let Some((render, audible)) = slot.as_ref() else { return; };
            let Ok(mut state) = render.try_lock() else { return; };
            let mut out = [0.0; 128];
            let frames = state.engine.render(&mut out);
            audible.store(frames > 0 && out.iter().any(|sample| *sample != 0.0), Ordering::Relaxed);
        });
    }

    fn flush(&self) {}
}

#[test]
fn callback_keeps_rendering_while_manual_plan_log_is_written() {
    static INIT: Once = Once::new();
    static LOGGER: CallbackProbe = CallbackProbe;
    INIT.call_once(|| log::set_logger(&LOGGER).unwrap());
    log::set_max_level(log::LevelFilter::Info);
    let track = PreparedTrack {
        path: PathBuf::from("synthetic-log-probe.wav"), playlist_index: 0,
        samples: Arc::new(vec![0.25; 88_200]), frames: 44_100,
        first_downbeat_out: 0, outro_start_out: 44_100, outro_end_anchored_out: 44_100,
        intro_bars: 0, outro_bars: 0, gain_linear: 1.0, preview: false, head_only: false,
    };
    let render = Arc::new(Mutex::new(RenderState {
        engine: Engine::from_prepared(EngineOptions::default(), vec![track]).unwrap(),
        audition: None, stall: StallWatch::new(44_100), was_in_transition: false,
    }));
    let audible = Arc::new(AtomicBool::new(false));
    CALLBACK.with(|slot| *slot.borrow_mut() = Some((Arc::clone(&render), Arc::clone(&audible))));
    log_manual_plan(&render);
    CALLBACK.with(|slot| *slot.borrow_mut() = None);
    assert!(audible.load(Ordering::Relaxed), "diagnostic logging denied the callback access to its engine");
}
