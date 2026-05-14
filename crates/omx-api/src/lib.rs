use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{IpAddr, Shutdown, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub type Result<T> = std::result::Result<T, OmxApiError>;

pub const DEFAULT_API_PORT: u16 = 14510;
const CODEX_RESPONSES_PATH: &str = "/responses";
const CODEX_DEFAULT_ORIGINATOR: &str = "codex_cli_rs";
const CODEX_DEFAULT_BACKEND_BASE_PATH: &str = "/backend-api/codex";
const CODEX_INSTALLATION_ID_HEADER: &str = "x-codex-installation-id";
const CODEX_WINDOW_ID_HEADER: &str = "x-codex-window-id";

#[derive(Debug)]
pub enum OmxApiError {
    Io(io::Error),
    Json(serde_json::Error),
    Message(String),
}

impl std::fmt::Display for OmxApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(f, "{error}"),
            Self::Json(error) => write!(f, "{error}"),
            Self::Message(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for OmxApiError {}

impl From<io::Error> for OmxApiError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<serde_json::Error> for OmxApiError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BackendMode {
    Mock,
    RealPrivate,
}

impl BackendMode {
    fn parse(value: &str) -> Result<Self> {
        match value {
            "mock" => Ok(Self::Mock),
            "real-private" => Ok(Self::RealPrivate),
            other => Err(OmxApiError::Message(format!(
                "unsupported backend mode '{other}'; expected mock or real-private"
            ))),
        }
    }

    fn as_str(&self) -> &'static str {
        match self {
            Self::Mock => "mock",
            Self::RealPrivate => "real-private",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
    pub backend: BackendMode,
    pub state_file: PathBuf,
    pub once: bool,
    pub daemon: bool,
    pub local_bearer_token: Option<String>,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            host: "127.0.0.1".to_string(),
            port: DEFAULT_API_PORT,
            backend: BackendMode::Mock,
            state_file: default_state_file(),
            once: false,
            daemon: false,
            local_bearer_token: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DaemonState {
    pub pid: u32,
    pub host: String,
    pub port: u16,
    pub backend: BackendMode,
    pub started_at_unix: u64,
    #[serde(skip)]
    pub local_bearer_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_bearer_token_file: Option<PathBuf>,
}

impl DaemonState {
    pub fn base_url(&self) -> String {
        format!("http://{}:{}", self.host, self.port)
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct TelemetrySnapshot {
    pub requests_total: u64,
    pub by_route: BTreeMap<String, u64>,
}

#[derive(Debug, Default)]
pub struct Telemetry {
    inner: Mutex<TelemetrySnapshot>,
}

impl Telemetry {
    pub fn record(&self, route: &str) {
        let mut inner = self.inner.lock().expect("telemetry lock poisoned");
        inner.requests_total += 1;
        *inner.by_route.entry(route.to_string()).or_insert(0) += 1;
    }

    pub fn snapshot(&self) -> TelemetrySnapshot {
        self.inner.lock().expect("telemetry lock poisoned").clone()
    }
}

#[derive(Clone, Debug)]
pub struct Request {
    pub method: String,
    pub path: String,
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
}

#[derive(Clone, Debug)]
pub struct Response {
    pub status: u16,
    pub content_type: String,
    pub body: Vec<u8>,
    pub extra_headers: Vec<(String, String)>,
}

impl Response {
    pub fn json(status: u16, value: Value) -> Self {
        let body = serde_json::to_vec(&value).expect("JSON serialization should not fail");
        Self {
            status,
            content_type: "application/json".to_string(),
            body,
            extra_headers: Vec::new(),
        }
    }

    pub fn text(status: u16, content_type: &str, body: impl Into<Vec<u8>>) -> Self {
        Self {
            status,
            content_type: content_type.to_string(),
            body: body.into(),
            extra_headers: Vec::new(),
        }
    }
}

pub fn default_state_file() -> PathBuf {
    env::temp_dir().join("omx-api-daemon.json")
}

pub fn write_daemon_state(path: impl AsRef<Path>, state: &DaemonState) -> Result<()> {
    let path = path.as_ref();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let bytes = serde_json::to_vec_pretty(state)?;
    fs::write(path, bytes)?;
    Ok(())
}

pub fn read_daemon_state(path: impl AsRef<Path>) -> Result<Option<DaemonState>> {
    let path = path.as_ref();
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(path)?;
    Ok(Some(serde_json::from_slice(&bytes)?))
}

pub fn remove_daemon_state(path: impl AsRef<Path>) -> Result<()> {
    let path = path.as_ref();
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn token_file_for_state(path: impl AsRef<Path>) -> PathBuf {
    let mut path = path.as_ref().to_path_buf();
    path.set_extension("token");
    path
}

fn write_local_bearer_token(path: impl AsRef<Path>, token: &str) -> Result<()> {
    let path = path.as_ref();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(path)?;
        file.write_all(token.as_bytes())?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        fs::write(path, token)?;
        Ok(())
    }
}

fn read_local_bearer_token(path: impl AsRef<Path>) -> Result<Option<String>> {
    let path = path.as_ref();
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(fs::read_to_string(path)?.trim().to_string()).filter(|token| !token.is_empty()))
}

fn remove_local_bearer_token(path: impl AsRef<Path>) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

pub fn redact_secrets(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut redact_next = false;
    for (index, token) in input.split_whitespace().enumerate() {
        if index > 0 {
            out.push(' ');
        }
        let lower = token.to_ascii_lowercase();
        if redact_next
            || lower.starts_with("sk-")
            || lower.starts_with("sess-")
            || lower.starts_with("bearer")
            || lower.contains("api_key=")
            || lower.contains("apikey=")
            || lower.contains("authorization:")
        {
            out.push_str("[REDACTED]");
            redact_next =
                lower == "bearer" || lower.ends_with("bearer") || lower.contains("authorization:");
        } else {
            out.push_str(token);
            redact_next = false;
        }
    }
    redact_json_secret_values(&out)
}

fn redact_json_secret_values(input: &str) -> String {
    let mut value: Value = match serde_json::from_str(input) {
        Ok(value) => value,
        Err(_) => return input.to_string(),
    };
    redact_value(&mut value);
    serde_json::to_string(&value).unwrap_or_else(|_| input.to_string())
}

fn redact_value(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, nested) in map {
                let key = key.to_ascii_lowercase();
                if key.contains("key")
                    || key.contains("token")
                    || key.contains("secret")
                    || key == "authorization"
                {
                    *nested = Value::String("[REDACTED]".to_string());
                } else {
                    redact_value(nested);
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                redact_value(item);
            }
        }
        Value::String(text) if text.starts_with("sk-") || text.starts_with("Bearer ") => {
            *text = "[REDACTED]".to_string();
        }
        _ => {}
    }
}

pub fn sse_event(event: Option<&str>, data: &Value) -> String {
    let mut output = String::new();
    if let Some(event) = event {
        output.push_str("event: ");
        output.push_str(event);
        output.push('\n');
    }
    let json = serde_json::to_string(data).expect("JSON serialization should not fail");
    for line in json.lines() {
        output.push_str("data: ");
        output.push_str(line);
        output.push('\n');
    }
    output.push('\n');
    output
}

pub fn sse_done() -> String {
    "data: [DONE]\n\n".to_string()
}

pub fn route_request(
    request: &Request,
    backend: &BackendMode,
    telemetry: &Telemetry,
    shutdown: Option<&AtomicBool>,
    expected_bearer: Option<&str>,
) -> Response {
    let route = canonical_route(&request.path);
    telemetry.record(route);

    if let Some(expected) = expected_bearer.filter(|token| !token.is_empty()) {
        if !has_matching_local_bearer(request, expected) {
            return Response::json(
                401,
                json!({
                    "error": {
                        "message": "matching local bearer token required",
                        "type": "unauthorized"
                    }
                }),
            );
        }
    } else if local_bearer_required() && !has_local_bearer(request) {
        return Response::json(
            401,
            json!({
                "error": {
                    "message": "local bearer token required by OMX_API_REQUIRE_LOCAL_BEARER",
                    "type": "unauthorized"
                }
            }),
        );
    }

    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/health") => Response::json(
            200,
            json!({
                "status": "ok",
                "backend": backend.as_str(),
            }),
        ),
        ("GET", "/v1/models") => Response::json(
            200,
            json!({
                "object": "list",
                "data": [
                    {"id": "omx-mock", "object": "model", "owned_by": "omx"},
                    {"id": "omx-private", "object": "model", "owned_by": "local"}
                ]
            }),
        ),
        ("POST", "/v1/responses") => responses_response(request, backend),
        ("POST", "/v1/chat/completions") => chat_response(request, backend),
        ("POST", "/v1/images/generations") => image_response(request, backend),
        ("GET", "/__admin/telemetry") => Response::json(200, json!(telemetry.snapshot())),
        ("POST", "/__admin/stop") => {
            if let Some(flag) = shutdown {
                flag.store(true, Ordering::SeqCst);
            }
            Response::json(200, json!({"status": "stopping"}))
        }
        _ => Response::json(
            404,
            json!({
                "error": {
                    "message": format!("no route for {} {}", request.method, request.path),
                    "type": "not_found"
                }
            }),
        ),
    }
}

fn local_bearer_required() -> bool {
    env::var("OMX_API_REQUIRE_LOCAL_BEARER")
        .ok()
        .map(|value| matches!(value.trim(), "1" | "true" | "TRUE" | "yes" | "on"))
        .unwrap_or(false)
}

fn has_matching_local_bearer(request: &Request, expected: &str) -> bool {
    request
        .headers
        .get("authorization")
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .is_some_and(|token| token == expected)
}

fn has_local_bearer(request: &Request) -> bool {
    request
        .headers
        .get("authorization")
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .is_some()
}

fn canonical_route(path: &str) -> &'static str {
    match path {
        "/health" => "/health",
        "/v1/models" => "/v1/models",
        "/v1/responses" => "/v1/responses",
        "/v1/chat/completions" => "/v1/chat/completions",
        "/v1/images/generations" => "/v1/images/generations",
        "/__admin/telemetry" => "/__admin/telemetry",
        "/__admin/stop" => "/__admin/stop",
        _ => "unknown",
    }
}

fn responses_response(request: &Request, backend: &BackendMode) -> Response {
    let body = match parse_json_body(request) {
        Ok(body) => body,
        Err(response) => return response,
    };
    if body.get("stream").and_then(Value::as_bool).unwrap_or(false) {
        if *backend == BackendMode::RealPrivate {
            return real_private_text_response(&body, "response", true);
        }
        let payload = json!({"type": "message", "delta": "omx mock response"});
        let mut stream = sse_event(Some("response.output_text.delta"), &payload);
        stream.push_str(&sse_done());
        return Response::text(200, "text/event-stream", stream.into_bytes());
    }

    if *backend == BackendMode::RealPrivate {
        return real_private_text_response(&body, "response", false);
    }

    let input = extract_prompt(&body);
    Response::json(
        200,
        json!({
            "id": format!("omx-{}", now_unix()),
            "object": "response",
            "model": body.get("model").and_then(Value::as_str).unwrap_or("omx-mock"),
            "backend": backend.as_str(),
            "output_text": format!("omx mock response to: {}", redact_secrets(&input)),
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": "omx mock response"},
                "finish_reason": "stop"
            }]
        }),
    )
}

fn chat_response(request: &Request, backend: &BackendMode) -> Response {
    let body = match parse_json_body(request) {
        Ok(body) => body,
        Err(response) => return response,
    };
    if body.get("stream").and_then(Value::as_bool).unwrap_or(false) {
        let text = if *backend == BackendMode::RealPrivate {
            match real_private_text(&body) {
                Ok(text) => text,
                Err((status, kind, message)) => {
                    return Response::json(
                        status,
                        json!({"error": {"message": message, "type": kind}}),
                    );
                }
            }
        } else {
            "omx mock response".to_string()
        };
        let chunk = json!({
            "id": format!("chatcmpl-omx-{}", now_unix()),
            "object": "chat.completion.chunk",
            "choices": [{"index": 0, "delta": {"content": text}, "finish_reason": null}]
        });
        let mut stream = sse_event(None, &chunk);
        stream.push_str(&sse_done());
        return Response::text(200, "text/event-stream", stream.into_bytes());
    }
    if *backend == BackendMode::RealPrivate {
        return real_private_text_response(&body, "chat.completion", false);
    }
    Response::json(
        200,
        json!({
            "id": format!("chatcmpl-omx-{}", now_unix()),
            "object": "chat.completion",
            "model": body.get("model").and_then(Value::as_str).unwrap_or("omx-mock"),
            "backend": backend.as_str(),
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": "omx mock response"},
                "finish_reason": "stop"
            }]
        }),
    )
}

fn real_private_text_response(body: &Value, object: &str, stream: bool) -> Response {
    match real_private_text(body) {
        Ok(text) => text_response_json(body, object, "real-private", &text, stream),
        Err((status, kind, message)) => Response::json(
            status,
            json!({
                "error": {
                    "message": message,
                    "type": kind
                }
            }),
        ),
    }
}

fn real_private_text(body: &Value) -> std::result::Result<String, (u16, &'static str, String)> {
    if let Some(fixture) = env::var("OMX_API_REAL_PRIVATE_RESPONSE_TEXT")
        .ok()
        .filter(|value| !value.trim().is_empty())
    {
        return Ok(fixture);
    }

    let Some(auth) = discover_codex_oauth() else {
        return Err((
            503,
            "missing_auth",
            "missing Codex OAuth token; run Codex login or set OMX_API_REAL_PRIVATE_RESPONSE_TEXT for fixture smoke tests".to_string(),
        ));
    };

    let Some(upstream) = env::var("OMX_API_PRIVATE_BACKEND_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
    else {
        return Err((
            501,
            "private_backend_unconfigured",
            "real-private OAuth was found, but OMX_API_PRIVATE_BACKEND_URL is not configured for this private backend build".to_string(),
        ));
    };

    match post_codex_responses_to_url(&upstream, body, &auth) {
        Ok(text) => Ok(text),
        Err(error) => Err((
            502,
            "private_backend_error",
            redact_secrets(&error.to_string()),
        )),
    }
}

fn text_response_json(
    body: &Value,
    object: &str,
    backend: &str,
    text: &str,
    stream: bool,
) -> Response {
    if stream {
        let mut output = sse_event(
            Some("response.created"),
            &json!({"type": "response.created", "response": {"backend": backend}}),
        );
        output.push_str(&sse_event(
            Some("response.output_text.delta"),
            &json!({"type": "response.output_text.delta", "delta": text}),
        ));
        output.push_str(&sse_event(
            Some("response.completed"),
            &json!({"type": "response.completed"}),
        ));
        output.push_str(&sse_done());
        return Response::text(200, "text/event-stream", output.into_bytes());
    }

    Response::json(
        200,
        json!({
            "id": format!("omx-{}", now_unix()),
            "object": object,
            "model": body.get("model").and_then(Value::as_str).unwrap_or("omx-private"),
            "backend": backend,
            "output_text": text,
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": text},
                "finish_reason": "stop"
            }]
        }),
    )
}

fn image_response(request: &Request, backend: &BackendMode) -> Response {
    if *backend == BackendMode::RealPrivate {
        return Response::json(
            501,
            json!({"error": {"message": "real-private image generation is not implemented in V1A", "type": "unsupported_request"}}),
        );
    }
    let body = match parse_json_body(request) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let prompt = body.get("prompt").and_then(Value::as_str).unwrap_or("");
    if body.get("stream").and_then(Value::as_bool).unwrap_or(false) {
        let mut stream = sse_event(
            Some("image_generation.partial_image"),
            &json!({"type": "image_generation.partial_image", "b64_json": "omx-mock-image-fragment"}),
        );
        stream.push_str(&sse_event(
            Some("image_generation.completed"),
            &json!({"type": "image_generation.completed"}),
        ));
        stream.push_str(&sse_done());
        return Response::text(200, "text/event-stream", stream.into_bytes());
    }
    Response::json(
        200,
        json!({
            "created": now_unix(),
            "backend": backend.as_str(),
            "data": [{
                "url": "https://localhost.omx.invalid/mock-image.png",
                "revised_prompt": redact_secrets(prompt)
            }]
        }),
    )
}

fn parse_json_body(request: &Request) -> std::result::Result<Value, Response> {
    if request.body.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_slice(&request.body).map_err(|error| {
        Response::json(
            400,
            json!({
                "error": {
                    "message": format!("invalid JSON request body: {error}"),
                    "type": "invalid_request_error"
                }
            }),
        )
    })
}

fn extract_prompt(body: &Value) -> String {
    if let Some(input) = body.get("input") {
        if let Some(text) = input.as_str() {
            return text.to_string();
        }
        return input.to_string();
    }
    if let Some(messages) = body.get("messages").and_then(Value::as_array) {
        return messages
            .iter()
            .filter_map(|message| message.get("content"))
            .map(|content| {
                content
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| content.to_string())
            })
            .collect::<Vec<_>>()
            .join("\n");
    }
    String::new()
}

#[derive(Clone, Debug, Default)]
struct CodexOAuth {
    token: String,
    account_id: Option<String>,
}

fn discover_codex_oauth() -> Option<CodexOAuth> {
    if let Some(token) = env::var("OMX_API_CODEX_OAUTH_TOKEN")
        .ok()
        .filter(|value| !value.trim().is_empty())
    {
        return Some(CodexOAuth {
            token,
            account_id: env::var("OMX_API_CODEX_ACCOUNT_ID")
                .ok()
                .filter(|value| !value.trim().is_empty()),
        });
    }

    let auth_path = env::var("CODEX_HOME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            env::var("HOME")
                .ok()
                .map(|home| PathBuf::from(home).join(".codex"))
        })
        .map(|home| home.join("auth.json"))?;
    let bytes = fs::read(auth_path).ok()?;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    Some(CodexOAuth {
        token: find_oauth_token(&value)?,
        account_id: find_codex_account_id(&value),
    })
}

fn find_oauth_token(value: &Value) -> Option<String> {
    match value {
        Value::Object(map) => {
            for preferred in ["access_token", "id_token", "oauth_token", "token"] {
                if let Some(token) = map
                    .get(preferred)
                    .and_then(Value::as_str)
                    .filter(|token| token.len() > 20)
                {
                    return Some(token.to_string());
                }
            }
            map.values().find_map(find_oauth_token)
        }
        Value::Array(items) => items.iter().find_map(find_oauth_token),
        _ => None,
    }
}

fn find_codex_account_id(value: &Value) -> Option<String> {
    match value {
        Value::Object(map) => {
            for preferred in ["account_id", "chatgpt_account_id"] {
                if let Some(account_id) = map
                    .get(preferred)
                    .and_then(Value::as_str)
                    .filter(|account_id| !account_id.trim().is_empty())
                {
                    return Some(account_id.to_string());
                }
            }
            map.values().find_map(find_codex_account_id)
        }
        Value::Array(items) => items.iter().find_map(find_codex_account_id),
        _ => None,
    }
}

#[derive(Debug)]
struct CodexNativeRequest {
    path: String,
    headers: Vec<(String, String)>,
    body: Value,
}

fn build_codex_native_request(
    upstream_path: &str,
    body: &Value,
    auth: &CodexOAuth,
) -> CodexNativeRequest {
    let session_id = env::var("OMX_API_CODEX_SESSION_ID")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "omx-api-local-session".to_string());
    let thread_id = env::var("OMX_API_CODEX_THREAD_ID")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "omx-api-local-thread".to_string());
    let installation_id = env::var("OMX_API_CODEX_INSTALLATION_ID")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "omx-api-local-installation".to_string());
    let window_id = env::var("OMX_API_CODEX_WINDOW_ID")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "omx-api-local-window".to_string());
    let model = body
        .get("model")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .or_else(|| env::var("OMX_API_GENERATE_MODEL").ok())
        .unwrap_or_else(|| "omx-private".to_string());
    let prompt = extract_prompt(body);
    let path = normalize_codex_responses_path(upstream_path);
    let mut request_body = json!({
        "model": model,
        "input": [{
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": prompt}]
        }],
        "tools": [],
        "tool_choice": "auto",
        "parallel_tool_calls": false,
        "reasoning": body.get("reasoning").cloned().unwrap_or(Value::Null),
        "store": false,
        "stream": true,
        "include": [],
        "prompt_cache_key": thread_id,
        "client_metadata": {
            CODEX_INSTALLATION_ID_HEADER: installation_id.clone()
        }
    });
    if let Some(instructions) = body.get("instructions").cloned() {
        request_body["instructions"] = instructions;
    }

    let mut headers = vec![
        ("Content-Type".to_string(), "application/json".to_string()),
        ("Accept".to_string(), "text/event-stream".to_string()),
        (
            "Authorization".to_string(),
            format!("Bearer {}", auth.token),
        ),
        (
            "originator".to_string(),
            CODEX_DEFAULT_ORIGINATOR.to_string(),
        ),
        ("User-Agent".to_string(), codex_user_agent()),
        ("x-client-request-id".to_string(), thread_id.clone()),
        ("session_id".to_string(), session_id.clone()),
        ("session-id".to_string(), session_id),
        ("thread_id".to_string(), thread_id.clone()),
        ("thread-id".to_string(), thread_id),
        (CODEX_WINDOW_ID_HEADER.to_string(), window_id),
    ];
    if let Some(account_id) = auth.account_id.as_ref() {
        headers.push(("ChatGPT-Account-ID".to_string(), account_id.clone()));
    }

    CodexNativeRequest {
        path,
        headers,
        body: request_body,
    }
}

fn codex_user_agent() -> String {
    env::var("OMX_API_CODEX_USER_AGENT")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "codex_cli_rs/0.130.0 (omx-api)".to_string())
}

fn normalize_codex_responses_path(path: &str) -> String {
    let path = if path == "/" || path.is_empty() {
        CODEX_DEFAULT_BACKEND_BASE_PATH
    } else {
        path.trim_end_matches('/')
    };
    if path.ends_with(CODEX_RESPONSES_PATH) {
        path.to_string()
    } else {
        format!("{path}{CODEX_RESPONSES_PATH}")
    }
}

fn post_codex_responses_to_url(url: &str, body: &Value, auth: &CodexOAuth) -> Result<String> {
    let parsed = parse_http_backend_url(url)?;
    let codex_request = build_codex_native_request(&parsed.path, body, auth);
    let payload = serde_json::to_vec(&codex_request.body)?;
    let mut stream = TcpStream::connect((parsed.host.as_str(), parsed.port))?;
    stream.set_read_timeout(Some(Duration::from_secs(120)))?;
    stream.set_write_timeout(Some(Duration::from_secs(30)))?;
    write!(
        stream,
        "POST {} HTTP/1.1\r\nHost: {}:{}\r\n",
        codex_request.path, parsed.host, parsed.port
    )?;
    for (name, value) in codex_request.headers {
        write!(stream, "{name}: {value}\r\n")?;
    }
    write!(
        stream,
        "Content-Length: {}\r\nConnection: close\r\n\r\n",
        payload.len()
    )?;
    stream.write_all(&payload)?;
    let mut raw = String::new();
    stream.read_to_string(&mut raw)?;
    let (head, response_body) = raw.split_once("\r\n\r\n").ok_or_else(|| {
        OmxApiError::Message("private backend returned malformed HTTP".to_string())
    })?;
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(502);
    if !(200..300).contains(&status) {
        return Err(OmxApiError::Message(format!(
            "private backend returned HTTP {status}: {response_body}"
        )));
    }

    Ok(extract_backend_text_response(response_body))
}

fn extract_backend_text_response(response_body: &str) -> String {
    if response_body
        .lines()
        .any(|line| line.starts_with("event:") || line.starts_with("data:"))
    {
        let mut text = String::new();
        for line in response_body.lines() {
            let Some(data) = line.strip_prefix("data:").map(str::trim) else {
                continue;
            };
            if data == "[DONE]" || data.is_empty() {
                continue;
            }
            if let Ok(value) = serde_json::from_str::<Value>(data) {
                if let Some(delta) = value.get("delta").and_then(Value::as_str) {
                    text.push_str(delta);
                } else if let Some(delta) = value
                    .pointer("/item/content/0/text")
                    .and_then(Value::as_str)
                {
                    text.push_str(delta);
                } else if let Some(delta) = value
                    .pointer("/response/output_text")
                    .and_then(Value::as_str)
                {
                    text.push_str(delta);
                }
            }
        }
        if !text.is_empty() {
            return text;
        }
    }

    let value: Value = serde_json::from_str(response_body)
        .unwrap_or_else(|_| json!({"output_text": response_body}));
    value
        .get("output_text")
        .and_then(Value::as_str)
        .or_else(|| {
            value
                .pointer("/choices/0/message/content")
                .and_then(Value::as_str)
        })
        .or_else(|| {
            value
                .pointer("/output/0/content/0/text")
                .and_then(Value::as_str)
        })
        .unwrap_or(response_body)
        .to_string()
}

#[derive(Debug)]
struct BackendUrl {
    host: String,
    port: u16,
    path: String,
}

fn parse_http_backend_url(url: &str) -> Result<BackendUrl> {
    let rest = url.strip_prefix("http://").ok_or_else(|| {
        OmxApiError::Message(
            "OMX_API_PRIVATE_BACKEND_URL must use http:// in V1A; use a localhost TLS terminator for HTTPS backends".to_string(),
        )
    })?;
    let (authority, path) = rest
        .split_once('/')
        .map(|(authority, path)| (authority, format!("/{path}")))
        .unwrap_or((rest, "/".to_string()));
    let (host, port) = if let Some((host, port)) = authority.rsplit_once(':') {
        let parsed = port
            .parse::<u16>()
            .map_err(|_| OmxApiError::Message(format!("invalid private backend port in {url}")))?;
        (host.to_string(), parsed)
    } else {
        (authority.to_string(), 80)
    };
    if host.is_empty() {
        return Err(OmxApiError::Message(format!(
            "empty private backend host in {url}"
        )));
    }
    if !is_loopback_host(&host) && env::var_os("OMX_API_ALLOW_UNSAFE_PRIVATE_BACKEND").is_none() {
        return Err(OmxApiError::Message(format!(
            "private backend host `{host}` is not loopback; set OMX_API_ALLOW_UNSAFE_PRIVATE_BACKEND=1 only for trusted development"
        )));
    }
    Ok(BackendUrl { host, port, path })
}

fn is_loopback_host(host: &str) -> bool {
    if host == "localhost" {
        return true;
    }
    let trimmed = host.trim_matches(['[', ']']);
    trimmed
        .parse::<IpAddr>()
        .map(|addr| addr.is_loopback())
        .unwrap_or(false)
}

pub fn serve(config: ServerConfig) -> Result<DaemonState> {
    validate_loopback_host(&config.host)?;
    let listener = TcpListener::bind((config.host.as_str(), config.port))?;
    let port = listener.local_addr()?.port();
    let state = DaemonState {
        pid: std::process::id(),
        host: config.host.clone(),
        port,
        backend: config.backend.clone(),
        started_at_unix: now_unix(),
        local_bearer_token: config.local_bearer_token.clone(),
        local_bearer_token_file: config
            .local_bearer_token
            .as_ref()
            .map(|_| token_file_for_state(&config.state_file)),
    };
    if let Some(token) = config.local_bearer_token.as_deref() {
        write_local_bearer_token(token_file_for_state(&config.state_file), token)?;
    }
    write_daemon_state(&config.state_file, &state)?;

    let telemetry = Arc::new(Telemetry::default());
    let shutdown = Arc::new(AtomicBool::new(false));

    for stream in listener.incoming() {
        let stream = stream?;
        handle_connection(
            stream,
            &config.backend,
            &telemetry,
            &shutdown,
            config.local_bearer_token.as_deref(),
        )?;
        if config.once || shutdown.load(Ordering::SeqCst) {
            break;
        }
    }
    remove_local_bearer_token(token_file_for_state(&config.state_file))?;
    remove_daemon_state(&config.state_file)?;
    Ok(state)
}

fn handle_connection(
    mut stream: TcpStream,
    backend: &BackendMode,
    telemetry: &Telemetry,
    shutdown: &AtomicBool,
    expected_bearer: Option<&str>,
) -> Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    stream.set_write_timeout(Some(Duration::from_secs(10)))?;
    let request = read_http_request(&mut stream)?;
    let response = route_request(
        &request,
        backend,
        telemetry,
        Some(shutdown),
        expected_bearer,
    );
    write_http_response(&mut stream, response)?;
    let _ = stream.shutdown(Shutdown::Both);
    Ok(())
}

pub fn read_http_request(stream: &mut TcpStream) -> Result<Request> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts
        .next()
        .unwrap_or("/")
        .split('?')
        .next()
        .unwrap_or("/")
        .to_string();

    let mut headers = BTreeMap::new();
    loop {
        let mut line = String::new();
        reader.read_line(&mut line)?;
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        if let Some((key, value)) = trimmed.split_once(':') {
            headers.insert(key.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }

    let length = headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;

    Ok(Request {
        method,
        path,
        headers,
        body,
    })
}

pub fn write_http_response(stream: &mut TcpStream, response: Response) -> Result<()> {
    let reason = reason_phrase(response.status);
    write!(
        stream,
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n",
        response.status,
        reason,
        response.content_type,
        response.body.len()
    )?;
    for (key, value) in response.extra_headers {
        write!(stream, "{}: {}\r\n", key, value)?;
    }
    write!(stream, "\r\n")?;
    stream.write_all(&response.body)?;
    stream.flush()?;
    Ok(())
}

fn reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        503 => "Service Unavailable",
        _ => "OK",
    }
}

pub fn stop_daemon(state_file: impl AsRef<Path>) -> Result<Value> {
    let Some(state) = read_daemon_state(&state_file)? else {
        return Ok(json!({"status": "not-running"}));
    };
    let response = http_request_with_bearer(
        &state.host,
        state.port,
        "POST",
        "/__admin/stop",
        Some(b"{}"),
        read_local_bearer_token(
            state
                .local_bearer_token_file
                .as_ref()
                .unwrap_or(&token_file_for_state(state_file.as_ref())),
        )?
        .as_deref(),
    )?;
    remove_local_bearer_token(
        state
            .local_bearer_token_file
            .as_ref()
            .unwrap_or(&token_file_for_state(state_file.as_ref())),
    )?;
    remove_daemon_state(state_file)?;
    Ok(json!({"status": "stopped", "response": response}))
}

pub fn status(state_file: impl AsRef<Path>) -> Result<Value> {
    Ok(match read_daemon_state(state_file)? {
        Some(state) => json!({"status": "running", "daemon": state, "base_url": state.base_url()}),
        None => json!({"status": "not-running"}),
    })
}

pub fn http_request(
    host: &str,
    port: u16,
    method: &str,
    path: &str,
    body: Option<&[u8]>,
) -> Result<String> {
    http_request_with_bearer(host, port, method, path, body, None)
}

pub fn http_request_with_bearer(
    host: &str,
    port: u16,
    method: &str,
    path: &str,
    body: Option<&[u8]>,
    bearer: Option<&str>,
) -> Result<String> {
    let mut stream = TcpStream::connect((host, port))?;
    let body = body.unwrap_or_default();
    write!(
        stream,
        "{} {} HTTP/1.1\r\nHost: {}:{}\r\nContent-Length: {}\r\n",
        method,
        path,
        host,
        port,
        body.len()
    )?;
    if let Some(token) = bearer.filter(|token| !token.is_empty()) {
        write!(stream, "Authorization: Bearer {token}\r\n")?;
    }
    write!(stream, "Connection: close\r\n\r\n")?;
    stream.write_all(body)?;
    let mut response = String::new();
    stream.read_to_string(&mut response)?;
    Ok(response)
}

pub fn http_json_request(
    host: &str,
    port: u16,
    method: &str,
    path: &str,
    body: &Value,
    bearer: Option<&str>,
) -> Result<String> {
    let payload = serde_json::to_vec(body)?;
    let raw = http_request_with_bearer(host, port, method, path, Some(&payload), bearer)?;
    let (head, response_body) = raw
        .split_once("\r\n\r\n")
        .ok_or_else(|| OmxApiError::Message("local API returned malformed HTTP".to_string()))?;
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(502);
    if !(200..300).contains(&status) {
        return Err(OmxApiError::Message(format!(
            "local API returned HTTP {status}: {response_body}"
        )));
    }
    Ok(response_body.to_string())
}

fn resolve_client_target(state_file: PathBuf) -> Result<(String, u16, Option<String>)> {
    if let Some(url) = env::var("OMX_API_BASE_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
    {
        let parsed = parse_http_backend_url(url.trim_end_matches('/'))?;
        return Ok((
            parsed.host,
            parsed.port,
            env::var("OMX_API_LOCAL_BEARER").ok(),
        ));
    }
    if let Some(state) = read_daemon_state(&state_file)? {
        let token = read_local_bearer_token(
            state
                .local_bearer_token_file
                .as_ref()
                .unwrap_or(&token_file_for_state(&state_file)),
        )?;
        return Ok((state.host, state.port, token));
    }
    let port = env::var("OMX_API_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(DEFAULT_API_PORT);
    Ok((
        "127.0.0.1".to_string(),
        port,
        env::var("OMX_API_LOCAL_BEARER").ok(),
    ))
}

fn spawn_daemon(config: &ServerConfig) -> Result<DaemonState> {
    let exe = env::current_exe()?;
    let token = config
        .local_bearer_token
        .clone()
        .unwrap_or_else(generate_local_bearer_token);
    let mut args = vec![
        "serve".to_string(),
        "--host".to_string(),
        config.host.clone(),
        "--port".to_string(),
        config.port.to_string(),
        "--backend".to_string(),
        config.backend.as_str().to_string(),
        "--state-file".to_string(),
        config.state_file.display().to_string(),
    ];
    if config.once {
        args.push("--once".to_string());
    }
    let mut child = Command::new(exe)
        .args(args)
        .env("OMX_API_LOCAL_BEARER", &token)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    for _ in 0..100 {
        if let Some(state) = read_daemon_state(&config.state_file)? {
            return Ok(state);
        }
        if let Some(status) = child.try_wait()? {
            return Err(OmxApiError::Message(format!(
                "daemon exited before writing state: {status}"
            )));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    Err(OmxApiError::Message(
        "daemon did not write state within timeout".to_string(),
    ))
}

pub fn run_cli<I, W, E>(args: I, mut stdout: W, _stderr: E) -> Result<()>
where
    I: IntoIterator,
    I::Item: Into<String>,
    W: Write,
    E: Write,
{
    let args: Vec<String> = args.into_iter().map(Into::into).collect();
    match args.first().map(String::as_str) {
        Some("serve") => {
            if args[1..].iter().any(|arg| arg == "--system") {
                if args[1..].iter().any(|arg| arg == "--dry-run") {
                    run_system_plan(&args[1..], stdout)?;
                    return Ok(());
                }
                return Err(OmxApiError::Message(
                    "serve --system is dry-run only in V1A; pass --dry-run to inspect the service plan"
                        .to_string(),
                ));
            }
            let config = parse_server_config(&args[1..])?;
            if config.daemon {
                let state = spawn_daemon(&config)?;
                writeln!(
                    stdout,
                    "{}",
                    serde_json::to_string_pretty(&json!({
                        "status": "started",
                        "daemon": state,
                        "base_url": state.base_url()
                    }))?
                )?;
            } else if config.once {
                let state = serve(config)?;
                writeln!(
                    stdout,
                    "{}",
                    serde_json::to_string(&json!({"served": state}))?
                )?;
            } else {
                serve(config)?;
            }
        }
        Some("generate") => run_generate(&args[1..], stdout)?,
        Some("smoke") => run_smoke(&args[1..], stdout)?,
        Some("status") => {
            let state_file = parse_state_file(&args[1..])?;
            writeln!(
                stdout,
                "{}",
                serde_json::to_string_pretty(&status(state_file)?)?
            )?;
        }
        Some("stop") => {
            let state_file = parse_state_file(&args[1..])?;
            writeln!(
                stdout,
                "{}",
                serde_json::to_string_pretty(&stop_daemon(state_file)?)?
            )?;
        }
        Some("system") => run_system(&args[1..], stdout)?,
        Some("help") | Some("--help") | Some("-h") | None => {
            writeln!(stdout, "{}", help_text())?;
        }
        Some(other) => {
            return Err(OmxApiError::Message(format!(
                "unknown subcommand '{other}'"
            )))
        }
    }
    Ok(())
}

fn run_system<W: Write>(args: &[String], mut stdout: W) -> Result<()> {
    match args.first().map(String::as_str) {
        Some("dry-run") => writeln!(
            stdout,
            "{}",
            serde_json::to_string_pretty(&json!({
                "ok": true,
                "action": "system.dry-run",
                "would_start": "omx-api serve --backend mock"
            }))?
        )?,
        Some("generate") => writeln!(
            stdout,
            "{}",
            serde_json::to_string_pretty(&json!({
                "ok": true,
                "action": "system.generate",
                "files": ["state-file", "localhost-http-server"]
            }))?
        )?,
        Some(other) => {
            return Err(OmxApiError::Message(format!(
                "unknown system action '{other}'"
            )))
        }
        None => {
            return Err(OmxApiError::Message(
                "system requires dry-run or generate".to_string(),
            ))
        }
    }
    Ok(())
}

fn run_system_plan<W: Write>(args: &[String], mut stdout: W) -> Result<()> {
    let mut service_args = vec!["serve".to_string()];
    for arg in args {
        if arg != "--system" && arg != "--dry-run" {
            service_args.push(arg.clone());
        }
    }
    writeln!(
        stdout,
        "{}",
        serde_json::to_string_pretty(&json!({
            "ok": true,
            "action": "serve.system.dry-run",
            "platform": env::consts::OS,
            "install_supported": false,
            "reason": "V1A emits a platform-aware service plan but refuses persistent service installation",
            "argv": service_args
        }))?
    )?;
    Ok(())
}

fn run_generate<W: Write>(args: &[String], mut stdout: W) -> Result<()> {
    let Some(kind) = args.first().map(String::as_str) else {
        return Err(OmxApiError::Message(
            "generate requires text or image".to_string(),
        ));
    };
    let mut state_file = default_state_file();
    let mut prompt_parts = Vec::new();
    let mut index = 1;
    while index < args.len() {
        match args[index].as_str() {
            "--state-file" => {
                index += 1;
                state_file = PathBuf::from(required_value(args, index, "--state-file")?);
            }
            value => prompt_parts.push(value.to_string()),
        }
        index += 1;
    }
    let prompt = prompt_parts.join(" ");
    if prompt.trim().is_empty() {
        return Err(OmxApiError::Message(format!(
            "generate {kind} requires a prompt"
        )));
    }
    let (host, port, bearer) = resolve_client_target(state_file)?;
    let (path, body) = match kind {
        "text" => (
            "/v1/responses",
            json!({"model": env::var("OMX_API_GENERATE_MODEL").unwrap_or_else(|_| "omx-private".to_string()), "input": prompt}),
        ),
        "image" => ("/v1/images/generations", json!({"prompt": prompt})),
        other => {
            return Err(OmxApiError::Message(format!(
                "unknown generate kind '{other}'; expected text or image"
            )))
        }
    };
    let response = http_json_request(&host, port, "POST", path, &body, bearer.as_deref())?;
    writeln!(stdout, "{response}")?;
    Ok(())
}

fn run_smoke<W: Write>(args: &[String], mut stdout: W) -> Result<()> {
    match args.first().map(String::as_str) {
        Some("text") => {
            if env::var_os("OMX_API_LIVE_SMOKE").is_none() {
                return Err(OmxApiError::Message(
                    "set OMX_API_LIVE_SMOKE=1 to run the real-private text smoke".to_string(),
                ));
            }
            let body = json!({"model": "omx-private", "input": "Say OMX API smoke OK."});
            let response = real_private_text_response(&body, "response", false);
            writeln!(stdout, "{}", String::from_utf8_lossy(&response.body).trim())?;
            Ok(())
        }
        _ => Err(OmxApiError::Message(
            "smoke requires text (example: OMX_API_LIVE_SMOKE=1 omx-api smoke text)".to_string(),
        )),
    }
}

fn parse_server_config(args: &[String]) -> Result<ServerConfig> {
    let mut config = ServerConfig {
        local_bearer_token: env::var("OMX_API_LOCAL_BEARER")
            .ok()
            .filter(|value| !value.trim().is_empty()),
        ..ServerConfig::default()
    };
    if let Some(backend) = env::var("OMX_API_BACKEND")
        .ok()
        .filter(|value| !value.trim().is_empty())
    {
        config.backend = BackendMode::parse(&backend)?;
    }
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--host" => {
                index += 1;
                config.host = required_value(args, index, "--host")?.to_string();
            }
            "--port" => {
                index += 1;
                config.port = required_value(args, index, "--port")?
                    .parse()
                    .map_err(|_| OmxApiError::Message("--port must be an integer".to_string()))?;
            }
            "--backend" => {
                index += 1;
                config.backend = BackendMode::parse(required_value(args, index, "--backend")?)?;
            }
            "--state-file" => {
                index += 1;
                config.state_file = PathBuf::from(required_value(args, index, "--state-file")?);
            }
            "--once" => config.once = true,
            "--daemon" => config.daemon = true,
            "--dry-run" => {}
            "--system" => {}
            other => {
                return Err(OmxApiError::Message(format!(
                    "unknown serve flag '{other}'"
                )))
            }
        }
        index += 1;
    }
    validate_loopback_host(&config.host)?;
    Ok(config)
}

fn validate_loopback_host(host: &str) -> Result<()> {
    if is_loopback_host(host) {
        Ok(())
    } else {
        Err(OmxApiError::Message(format!(
            "omx-api is localhost-only; refusing non-loopback host `{host}`"
        )))
    }
}

fn generate_local_bearer_token() -> String {
    let mut bytes = [0_u8; 32];
    if fs::File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut bytes))
        .is_err()
    {
        let seed = format!("{}-{}", std::process::id(), now_unix());
        for (index, byte) in seed.as_bytes().iter().enumerate() {
            bytes[index % bytes.len()] ^= *byte;
        }
    }
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn parse_state_file(args: &[String]) -> Result<PathBuf> {
    let mut state_file = default_state_file();
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--state-file" => {
                index += 1;
                state_file = PathBuf::from(required_value(args, index, "--state-file")?);
            }
            other => return Err(OmxApiError::Message(format!("unknown flag '{other}'"))),
        }
        index += 1;
    }
    Ok(state_file)
}

fn required_value<'a>(args: &'a [String], index: usize, flag: &str) -> Result<&'a str> {
    args.get(index)
        .map(String::as_str)
        .ok_or_else(|| OmxApiError::Message(format!("{flag} requires a value")))
}

fn help_text() -> &'static str {
    "omx-api serve [--daemon] [--system --dry-run]|status|stop|generate text|generate image|smoke text"
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .expect("env lock")
    }

    fn request(method: &str, path: &str, body: Value) -> Request {
        Request {
            method: method.to_string(),
            path: path.to_string(),
            headers: BTreeMap::new(),
            body: serde_json::to_vec(&body).unwrap(),
        }
    }

    #[test]
    fn routes_health_and_models() {
        let telemetry = Telemetry::default();
        let health = route_request(
            &request("GET", "/health", json!({})),
            &BackendMode::Mock,
            &telemetry,
            None,
            None,
        );
        assert_eq!(health.status, 200);
        assert!(String::from_utf8(health.body).unwrap().contains("mock"));

        let models = route_request(
            &request("GET", "/v1/models", json!({})),
            &BackendMode::Mock,
            &telemetry,
            None,
            None,
        );
        assert_eq!(models.status, 200);
        assert!(String::from_utf8(models.body).unwrap().contains("omx-mock"));
        assert_eq!(telemetry.snapshot().requests_total, 2);
    }

    #[test]
    fn response_endpoint_redacts_prompt_secrets() {
        let telemetry = Telemetry::default();
        let response = route_request(
            &request(
                "POST",
                "/v1/responses",
                json!({"input": "use sk-secret123 please"}),
            ),
            &BackendMode::Mock,
            &telemetry,
            None,
            None,
        );
        let body = String::from_utf8(response.body).unwrap();
        assert!(body.contains("[REDACTED]"));
        assert!(!body.contains("sk-secret123"));
    }

    #[test]
    fn post_endpoints_reject_malformed_json() {
        let telemetry = Telemetry::default();
        for path in [
            "/v1/responses",
            "/v1/chat/completions",
            "/v1/images/generations",
        ] {
            let malformed = Request {
                method: "POST".to_string(),
                path: path.to_string(),
                headers: BTreeMap::new(),
                body: b"{bad json".to_vec(),
            };
            let response = route_request(&malformed, &BackendMode::Mock, &telemetry, None, None);
            assert_eq!(response.status, 400, "{path} should reject malformed JSON");
            let body = String::from_utf8(response.body).unwrap();
            assert!(body.contains("invalid_request_error"));
        }
    }

    #[test]
    fn redacts_bearer_credentials_as_pairs() {
        let redacted = redact_secrets("Authorization: Bearer abc123 and Bearer def456");
        assert!(!redacted.contains("abc123"));
        assert!(!redacted.contains("def456"));
        assert!(redacted.contains("[REDACTED] [REDACTED]"));
    }

    #[test]
    fn route_requires_matching_local_bearer_when_configured() {
        let telemetry = Telemetry::default();
        let response = route_request(
            &request("GET", "/v1/models", json!({})),
            &BackendMode::Mock,
            &telemetry,
            None,
            Some("secret-token"),
        );
        assert_eq!(response.status, 401);

        let mut authed = request("GET", "/v1/models", json!({}));
        authed.headers.insert(
            "authorization".to_string(),
            "Bearer secret-token".to_string(),
        );
        let response = route_request(
            &authed,
            &BackendMode::Mock,
            &telemetry,
            None,
            Some("secret-token"),
        );
        assert_eq!(response.status, 200);
    }

    #[test]
    fn private_backend_url_rejects_non_loopback_plain_http() {
        let error = parse_http_backend_url("http://example.com/v1/responses")
            .expect_err("non-loopback private backend must be rejected");
        assert!(error.to_string().contains("not loopback"));
        let error = parse_http_backend_url("http://127.0.0.1.evil.test/v1/responses")
            .expect_err("hostname prefix must not bypass loopback check");
        assert!(error.to_string().contains("not loopback"));
    }

    #[test]
    fn codex_native_request_matches_installed_codex_responses_wire_shape() {
        let _guard = env_lock();
        env::set_var("OMX_API_CODEX_SESSION_ID", "session-1");
        env::set_var("OMX_API_CODEX_THREAD_ID", "thread-1");
        env::set_var("OMX_API_CODEX_INSTALLATION_ID", "install-1");
        env::set_var("OMX_API_CODEX_WINDOW_ID", "window-1");
        env::set_var("OMX_API_CODEX_USER_AGENT", "codex_cli_rs/test");

        let auth = CodexOAuth {
            token: "oauth-token".to_string(),
            account_id: Some("account-1".to_string()),
        };
        let request = build_codex_native_request(
            "/backend-api/codex",
            &json!({
                "model": "gpt-5.3-codex",
                "input": "summarize this",
                "reasoning": {"effort": "low"},
                "instructions": "Follow the sparkshell summary contract."
            }),
            &auth,
        );

        assert_eq!(request.path, "/backend-api/codex/responses");
        assert!(request
            .headers
            .contains(&("Accept".to_string(), "text/event-stream".to_string())));
        assert!(request.headers.contains(&(
            "Authorization".to_string(),
            "Bearer oauth-token".to_string()
        )));
        assert!(request
            .headers
            .contains(&("ChatGPT-Account-ID".to_string(), "account-1".to_string())));
        assert!(request
            .headers
            .contains(&("originator".to_string(), "codex_cli_rs".to_string())));
        assert!(request
            .headers
            .contains(&("x-client-request-id".to_string(), "thread-1".to_string())));
        assert!(request
            .headers
            .contains(&("session_id".to_string(), "session-1".to_string())));
        assert!(request
            .headers
            .contains(&("session-id".to_string(), "session-1".to_string())));
        assert!(request
            .headers
            .contains(&("thread_id".to_string(), "thread-1".to_string())));
        assert!(request
            .headers
            .contains(&("thread-id".to_string(), "thread-1".to_string())));
        assert!(!request
            .headers
            .iter()
            .any(|(name, _)| name == CODEX_INSTALLATION_ID_HEADER));

        assert_eq!(request.body["model"], "gpt-5.3-codex");
        assert_eq!(request.body["tools"], json!([]));
        assert_eq!(request.body["tool_choice"], "auto");
        assert_eq!(request.body["parallel_tool_calls"], false);
        assert_eq!(request.body["reasoning"], json!({"effort": "low"}));
        assert_eq!(
            request.body["instructions"],
            "Follow the sparkshell summary contract."
        );
        assert_eq!(request.body["store"], false);
        assert_eq!(request.body["stream"], true);
        assert_eq!(request.body["include"], json!([]));
        assert_eq!(request.body["prompt_cache_key"], "thread-1");
        assert_eq!(
            request.body["client_metadata"][CODEX_INSTALLATION_ID_HEADER],
            "install-1"
        );
        assert_eq!(
            request.body["input"],
            json!([{
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "summarize this"}]
            }])
        );

        env::remove_var("OMX_API_CODEX_SESSION_ID");
        env::remove_var("OMX_API_CODEX_THREAD_ID");
        env::remove_var("OMX_API_CODEX_INSTALLATION_ID");
        env::remove_var("OMX_API_CODEX_WINDOW_ID");
        env::remove_var("OMX_API_CODEX_USER_AGENT");
    }

    #[test]
    fn real_private_posts_codex_native_request_and_parses_sse_text() {
        let _guard = env_lock();
        env::remove_var("OMX_API_REAL_PRIVATE_RESPONSE_TEXT");
        env::set_var("OMX_API_CODEX_OAUTH_TOKEN", "oauth-token");
        env::set_var("OMX_API_CODEX_ACCOUNT_ID", "account-1");
        env::set_var("OMX_API_CODEX_THREAD_ID", "thread-1");
        env::set_var("OMX_API_CODEX_SESSION_ID", "session-1");

        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind private backend");
        let addr = listener.local_addr().expect("local addr");
        let seen = Arc::new(Mutex::new(String::new()));
        let seen_thread = Arc::clone(&seen);
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept request");
            let mut raw_bytes = Vec::new();
            let mut buffer = [0_u8; 1024];
            let header_end = loop {
                let read = stream.read(&mut buffer).expect("read request");
                assert!(read > 0, "request closed before headers");
                raw_bytes.extend_from_slice(&buffer[..read]);
                if let Some(index) = raw_bytes.windows(4).position(|chunk| chunk == b"\r\n\r\n") {
                    break index + 4;
                }
            };
            let head = String::from_utf8_lossy(&raw_bytes[..header_end]).to_string();
            let content_length = head
                .lines()
                .find_map(|line| line.strip_prefix("Content-Length: "))
                .and_then(|value| value.trim().parse::<usize>().ok())
                .expect("content length");
            while raw_bytes.len() < header_end + content_length {
                let read = stream.read(&mut buffer).expect("read body");
                assert!(read > 0, "request closed before body");
                raw_bytes.extend_from_slice(&buffer[..read]);
            }
            let raw = String::from_utf8_lossy(&raw_bytes).to_string();
            *seen_thread.lock().expect("seen lock") = raw;
            let body = concat!(
                "event: response.output_text.delta\n",
                "data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\n",
                "data: [DONE]\n\n"
            );
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .expect("write response");
        });

        env::set_var(
            "OMX_API_PRIVATE_BACKEND_URL",
            format!("http://127.0.0.1:{}/backend-api/codex", addr.port()),
        );
        let text = real_private_text(&json!({
            "model": "gpt-5.3-codex",
            "input": "ping",
            "reasoning": {"effort": "low"},
            "instructions": "Summarize via sparkshell."
        }))
        .expect("private text response");
        handle.join().expect("server thread");

        assert_eq!(text, "hello");
        let raw = seen.lock().expect("seen lock").clone();
        assert!(raw.starts_with("POST /backend-api/codex/responses HTTP/1.1"));
        assert!(raw.contains("Accept: text/event-stream\r\n"));
        assert!(raw.contains("Authorization: Bearer oauth-token\r\n"));
        assert!(raw.contains("ChatGPT-Account-ID: account-1\r\n"));
        assert!(raw.contains("originator: codex_cli_rs\r\n"));
        assert!(raw.contains("\"stream\":true") || raw.contains("\"stream\": true"));
        assert!(
            raw.contains("\"prompt_cache_key\":\"thread-1\"")
                || raw.contains("\"prompt_cache_key\": \"thread-1\"")
        );
        assert!(
            raw.contains("\"type\":\"input_text\"") || raw.contains("\"type\": \"input_text\"")
        );
        assert!(raw.contains("\"text\":\"ping\"") || raw.contains("\"text\": \"ping\""));
        let forwarded_body = raw.split("\r\n\r\n").nth(1).expect("forwarded body");
        let forwarded_json: Value = serde_json::from_str(forwarded_body).expect("forwarded JSON");
        assert_eq!(forwarded_json["reasoning"], json!({"effort": "low"}));
        assert_eq!(forwarded_json["instructions"], "Summarize via sparkshell.");

        env::remove_var("OMX_API_CODEX_OAUTH_TOKEN");
        env::remove_var("OMX_API_CODEX_ACCOUNT_ID");
        env::remove_var("OMX_API_CODEX_THREAD_ID");
        env::remove_var("OMX_API_CODEX_SESSION_ID");
        env::remove_var("OMX_API_PRIVATE_BACKEND_URL");
    }

    #[test]
    fn chat_stream_response_uses_chat_chunk_shape() {
        let telemetry = Telemetry::default();
        let response = route_request(
            &request(
                "POST",
                "/v1/chat/completions",
                json!({"stream": true, "messages": []}),
            ),
            &BackendMode::Mock,
            &telemetry,
            None,
            None,
        );
        assert_eq!(response.content_type, "text/event-stream");
        let body = String::from_utf8(response.body).unwrap();
        assert!(body.contains("\"object\":\"chat.completion.chunk\""));
        assert!(body.contains("\"delta\":{\"content\":\"omx mock response\"}"));
        assert!(body.contains("data: [DONE]"));
    }

    #[test]
    fn image_stream_response_uses_image_events() {
        let telemetry = Telemetry::default();
        let response = route_request(
            &request(
                "POST",
                "/v1/images/generations",
                json!({"stream": true, "prompt": "x"}),
            ),
            &BackendMode::Mock,
            &telemetry,
            None,
            None,
        );
        assert_eq!(response.content_type, "text/event-stream");
        let body = String::from_utf8(response.body).unwrap();
        assert!(body.contains("event: image_generation.partial_image"));
        assert!(body.contains("data: [DONE]"));
    }

    #[test]
    fn real_private_image_is_unsupported_request() {
        env::remove_var("OMX_API_REAL_PRIVATE_ALLOW");
        let telemetry = Telemetry::default();
        let response = route_request(
            &request("POST", "/v1/images/generations", json!({"prompt": "x"})),
            &BackendMode::RealPrivate,
            &telemetry,
            None,
            None,
        );
        assert_eq!(response.status, 501);
    }

    #[test]
    fn real_private_chat_stream_preserves_backend_errors() {
        let _guard = env_lock();
        env::remove_var("OMX_API_REAL_PRIVATE_RESPONSE_TEXT");
        env::remove_var("OMX_API_CODEX_OAUTH_TOKEN");
        env::remove_var("OMX_API_PRIVATE_BACKEND_URL");
        let telemetry = Telemetry::default();
        let response = route_request(
            &request(
                "POST",
                "/v1/chat/completions",
                json!({"stream": true, "messages": []}),
            ),
            &BackendMode::RealPrivate,
            &telemetry,
            None,
            None,
        );
        assert_eq!(response.status, 503);
        assert_eq!(response.content_type, "application/json");
        let body = String::from_utf8(response.body).unwrap();
        assert!(body.contains("missing_auth"));
    }

    #[test]
    fn daemon_state_round_trips() {
        let path = env::temp_dir().join(format!("omx-api-test-{}.json", now_unix()));
        let state = DaemonState {
            pid: 42,
            host: "127.0.0.1".to_string(),
            port: 9999,
            backend: BackendMode::Mock,
            started_at_unix: 1,
            local_bearer_token: None,
            local_bearer_token_file: None,
        };
        write_daemon_state(&path, &state).unwrap();
        let raw = fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("local_bearer_token"));
        let read = read_daemon_state(&path).unwrap().unwrap();
        assert_eq!(read.pid, 42);
        remove_daemon_state(&path).unwrap();
        assert!(read_daemon_state(&path).unwrap().is_none());
    }

    #[test]
    fn cli_system_dry_run_is_json() {
        let mut out = Vec::new();
        run_cli(["system", "dry-run"], &mut out, io::sink()).unwrap();
        let value: Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(value["action"], "system.dry-run");
    }
}
