//! Opt-in, loopback-only current-track endpoint for local companion tools.
//!
//! This deliberately is a tiny HTTP reader rather than a Tauri command: the
//! consumer is a separate local process. It has no controls and is started
//! only on Windows when `FUNKOT_CURRENT_TRACK_PORT` names a valid port.

use std::env;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

const MAX_HEADER_BYTES: usize = 8 * 1024;
const IO_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct CurrentTrackSnapshot {
    version: u8,
    title: String,
    artist: String,
    playing: bool,
}

impl CurrentTrackSnapshot {
    pub(crate) fn empty() -> Self {
        Self { version: 1, title: String::new(), artist: String::new(), playing: false }
    }

    /// Maps the player state to the public contract. Keep this pure so the
    /// transport-state rules do not depend on TCP handling.
    pub(crate) fn from_state(
        metadata: Option<(String, String)>,
        phase_is_playing: bool,
        paused: bool,
        auditioning: bool,
    ) -> Self {
        match (metadata, auditioning) {
            (Some((title, artist)), false) => Self {
                version: 1,
                title,
                artist,
                playing: phase_is_playing && !paused,
            },
            _ => Self::empty(),
        }
    }
}

/// Starts the endpoint if the operator opted in with a valid non-zero port.
/// Startup failure is intentionally non-fatal: playback must never depend on
/// an optional display integration.
pub(crate) fn start(snapshot: fn() -> CurrentTrackSnapshot) {
    let Some(port) = configured_port() else { return; };
    let addr = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    match TcpListener::bind(addr) {
        Ok(listener) => {
            log::info!("current-track API listening on http://127.0.0.1:{port}/now-playing");
            if let Err(err) = thread::Builder::new()
                .name("current-track-http".into())
                .spawn(move || serve(listener, port, snapshot))
            {
                log::warn!("current-track API disabled: cannot start thread: {err}");
            }
        }
        Err(err) => log::warn!("current-track API disabled: cannot bind 127.0.0.1:{port}: {err}"),
    }
}

fn configured_port() -> Option<u16> {
    match env::var("FUNKOT_CURRENT_TRACK_PORT") {
        Ok(raw) => configured_port_value(Some(&raw)),
        Err(env::VarError::NotPresent) => None,
        Err(err) => {
            log::warn!("current-track API disabled: cannot read FUNKOT_CURRENT_TRACK_PORT: {err}");
            None
        }
    }
}

fn configured_port_value(raw: Option<&str>) -> Option<u16> {
    let raw = match raw {
        Some(raw) => raw,
        None => return None,
    };
    match raw.parse::<u16>() {
        Ok(0) => None,
        Ok(port) => Some(port),
        Err(_) => { log::warn!("current-track API disabled: FUNKOT_CURRENT_TRACK_PORT must be a port number (0 disables it)"); None }
    }
}

fn serve(listener: TcpListener, port: u16, snapshot: fn() -> CurrentTrackSnapshot) {
    for stream in listener.incoming() {
        match stream { Ok(stream) => serve_connection(stream, port, snapshot), Err(err) => log::warn!("current-track API accept failed: {err}"), }
    }
}

fn serve_connection(mut stream: TcpStream, port: u16, snapshot: fn() -> CurrentTrackSnapshot) {
    if stream.set_read_timeout(Some(Duration::from_millis(100))).is_err()
        || stream.set_write_timeout(Some(IO_TIMEOUT)).is_err()
    {
        return;
    }
    let response = match read_request(&mut stream) {
        Ok(request) => match classify_request(&request, port) {
            RequestKind::NowPlaying => json_response(snapshot()),
            RequestKind::MethodNotAllowed => plain_response("405 Method Not Allowed", "method not allowed\n"),
            RequestKind::NotFound => plain_response("404 Not Found", "not found\n"),
            RequestKind::Forbidden => plain_response("403 Forbidden", "forbidden\n"),
            RequestKind::Malformed => plain_response("400 Bad Request", "bad request\n"),
        },
        Err(_) => plain_response("400 Bad Request", "bad request\n"),
    };
    let _ = stream.write_all(&response);
    let _ = stream.flush();
}

fn read_request(stream: &mut TcpStream) -> Result<Vec<u8>, ()> {
    let deadline = Instant::now() + IO_TIMEOUT;
    let mut bytes = Vec::with_capacity(1024);
    let mut chunk = [0_u8; 1024];
    loop {
        if Instant::now() >= deadline || bytes.len() >= MAX_HEADER_BYTES { return Err(()); }
        match stream.read(&mut chunk) {
            Ok(0) => return Err(()),
            Ok(n) => {
                let remaining = MAX_HEADER_BYTES - bytes.len();
                if n > remaining { return Err(()); }
                bytes.extend_from_slice(&chunk[..n]);
                if bytes.windows(4).any(|w| w == b"\r\n\r\n") { return Ok(bytes); }
            }
            Err(err) if err.kind() == std::io::ErrorKind::WouldBlock || err.kind() == std::io::ErrorKind::TimedOut => continue,
            Err(_) => return Err(()),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RequestKind {
    NowPlaying,
    MethodNotAllowed,
    NotFound,
    Forbidden,
    Malformed,
}

fn classify_request(bytes: &[u8], port: u16) -> RequestKind {
    let Ok(request) = std::str::from_utf8(bytes) else { return RequestKind::Malformed; };
    let mut lines = request.split("\r\n");
    let Some(request_line) = lines.next() else { return RequestKind::Malformed; };
    let mut request_parts = request_line.split(' ');
    let (Some(method), Some(path), Some(version), None) = (request_parts.next(), request_parts.next(), request_parts.next(), request_parts.next()) else {
        return RequestKind::Malformed;
    };
    if version != "HTTP/1.1" { return RequestKind::Malformed; }
    let expected_ip = format!("127.0.0.1:{port}");
    let expected_localhost = format!("localhost:{port}");
    let mut host_seen = false;
    let mut valid_host = false;
    for line in lines {
        if line.is_empty() { break; }
        let Some((name, value)) = line.split_once(':') else { return RequestKind::Malformed; };
        if name.eq_ignore_ascii_case("origin") { return RequestKind::Forbidden; }
        if name.eq_ignore_ascii_case("host") {
            if host_seen { return RequestKind::Forbidden; }
            host_seen = true;
            let value = value.trim();
            valid_host = value == expected_ip || value == expected_localhost;
        }
    }
    if !valid_host { return RequestKind::Forbidden; }
    if method != "GET" { return RequestKind::MethodNotAllowed; }
    if path != "/now-playing" { return RequestKind::NotFound; }
    RequestKind::NowPlaying
}

fn json_response(snapshot: CurrentTrackSnapshot) -> Vec<u8> {
    let body = serde_json::to_vec(&snapshot).expect("current-track snapshot always serializes");
    response("200 OK", "application/json", &body)
}

fn plain_response(status: &str, body: &str) -> Vec<u8> { response(status, "text/plain; charset=utf-8", body.as_bytes()) }

fn response(status: &str, content_type: &str, body: &[u8]) -> Vec<u8> {
    let mut response = format!("HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n", body.len()).into_bytes();
    response.extend_from_slice(body);
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpStream;

    fn example_snapshot() -> CurrentTrackSnapshot {
        CurrentTrackSnapshot::from_state(Some(("曲\"名".into(), "Artist".into())), true, false, false)
    }

    #[test]
    fn snapshot_has_the_literal_consumer_json_shape() {
        assert_eq!(String::from_utf8(serde_json::to_vec(&example_snapshot()).unwrap()).unwrap(), r#"{"version":1,"title":"曲\"名","artist":"Artist","playing":true}"#);
    }

    #[test]
    fn snapshot_mapping_handles_pause_stall_audition_and_no_track() {
        let metadata = Some(("Title".into(), "Artist".into()));
        assert!(CurrentTrackSnapshot::from_state(metadata.clone(), true, false, false).playing);
        let paused = CurrentTrackSnapshot::from_state(metadata.clone(), true, true, false);
        assert_eq!((paused.title.as_str(), paused.artist.as_str(), paused.playing), ("Title", "Artist", false));
        assert!(!CurrentTrackSnapshot::from_state(metadata.clone(), false, false, false).playing);
        assert_eq!(CurrentTrackSnapshot::from_state(metadata, true, false, true), CurrentTrackSnapshot::empty());
        assert_eq!(CurrentTrackSnapshot::from_state(None, true, false, false), CurrentTrackSnapshot::empty());
    }

    #[test]
    fn port_configuration_is_opt_in_and_rejects_invalid_values() {
        assert_eq!(configured_port_value(None), None);
        assert_eq!(configured_port_value(Some("0")), None);
        assert_eq!(configured_port_value(Some("43123")), Some(43123));
        assert_eq!(configured_port_value(Some("-1")), None);
        assert_eq!(configured_port_value(Some("not-a-port")), None);
    }

    #[test]
    fn request_filter_allows_only_local_host_get_without_origin() {
        assert_eq!(classify_request(b"GET /now-playing HTTP/1.1\r\nHost: localhost:43123\r\n\r\n", 43123), RequestKind::NowPlaying);
        assert_eq!(classify_request(b"GET /now-playing HTTP/1.1\r\nHost: 127.0.0.1:43123\r\n\r\n", 43123), RequestKind::NowPlaying);
        assert_eq!(classify_request(b"GET /now-playing HTTP/1.1\r\n\r\n", 43123), RequestKind::Forbidden);
        assert_eq!(classify_request(b"GET /now-playing HTTP/1.1\r\nHost: localhost:1\r\n\r\n", 43123), RequestKind::Forbidden);
        assert_eq!(classify_request(b"GET /now-playing HTTP/1.1\r\nHost: evil.test\r\nHost: localhost:43123\r\n\r\n", 43123), RequestKind::Forbidden);
        assert_eq!(classify_request(b"GET /now-playing HTTP/1.1\r\nHost: localhost:43123\r\nOrigin: http://evil.test\r\n\r\n", 43123), RequestKind::Forbidden);
        assert_eq!(classify_request(b"POST /now-playing HTTP/1.1\r\nHost: localhost:43123\r\n\r\n", 43123), RequestKind::MethodNotAllowed);
        assert_eq!(classify_request(b"GET /other HTTP/1.1\r\nHost: localhost:43123\r\n\r\n", 43123), RequestKind::NotFound);
    }

    #[test]
    fn listener_serves_json_over_the_documented_route() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let join = thread::spawn(move || { let (stream, _) = listener.accept().unwrap(); serve_connection(stream, port, example_snapshot); });
        let mut client = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
        client.write_all(format!("GET /now-playing HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n").as_bytes()).unwrap();
        let mut response = String::new();
        client.read_to_string(&mut response).unwrap();
        join.join().unwrap();
        assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(response.contains("Content-Type: application/json\r\n"));
        assert!(response.contains("Cache-Control: no-store\r\n"));
        assert!(response.ends_with("{\"version\":1,\"title\":\"曲\\\"名\",\"artist\":\"Artist\",\"playing\":true}"));
    }
}
