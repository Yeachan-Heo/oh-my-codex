use fs2::FileExt;
use omx_mux::{canonical_contract_summary, MuxAdapter, MuxOperation, MuxTarget, TmuxAdapter};
use omx_runtime_core::{runtime_contract_summary, RuntimeCommand, RuntimeEngine};
use std::env;
use std::process;

fn main() {
    if let Err(error) = run() {
        eprintln!("omx-runtime: {error}");
        process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let args: Vec<String> = env::args().skip(1).collect();
    let first = args.first().map(|s| s.as_str());
    let second = args.get(1).map(|s| s.as_str());

    match first {
        None | Some("--help") | Some("-h") => {
            print_usage();
            Ok(())
        }
        Some("schema") => {
            if second == Some("--json") {
                let summary = serde_json::json!({
                    "schema_version": omx_runtime_core::RUNTIME_SCHEMA_VERSION,
                    "commands": omx_runtime_core::RUNTIME_COMMAND_NAMES,
                    "events": omx_runtime_core::RUNTIME_EVENT_NAMES,
                    "transport": "tmux",
                });
                println!(
                    "{}",
                    serde_json::to_string_pretty(&summary).map_err(|e| e.to_string())?
                );
            } else {
                println!("{}", runtime_contract_summary());
            }
            Ok(())
        }
        Some("snapshot") => {
            let state_dir = args.iter().find_map(|a| a.strip_prefix("--state-dir="));
            let engine = if let Some(dir) = state_dir {
                RuntimeEngine::load(dir).map_err(|e| e.to_string())?
            } else {
                RuntimeEngine::new()
            };
            let snapshot = engine.snapshot();
            if second == Some("--json") || args.get(2).map(|s| s.as_str()) == Some("--json") {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&snapshot).map_err(|e| e.to_string())?
                );
            } else {
                println!("{snapshot}");
            }
            Ok(())
        }
        Some("mux-contract") => {
            let adapter = TmuxAdapter::new();
            println!("adapter-status={}", adapter.status());
            println!("{}", canonical_contract_summary());
            let sample = MuxOperation::InspectLiveness {
                target: MuxTarget::Detached,
            };
            if let Err(error) = adapter.execute(&sample) {
                println!("sample-operation={error}");
            }
            Ok(())
        }
        Some("exec") => {
            let json_input = second.ok_or("exec requires a JSON command argument")?;
            let state_dir = args.iter().find_map(|a| a.strip_prefix("--state-dir="));
            let compact = args.iter().any(|a| a == "--compact");
            let _mutation_lock = if let Some(dir) = state_dir {
                std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
                let lock =
                    std::fs::File::create(std::path::Path::new(dir).join("runtime-mutation.lock"))
                        .map_err(|e| e.to_string())?;
                lock.lock_exclusive().map_err(|e| e.to_string())?;
                Some(lock)
            } else {
                None
            };
            let mut engine = match state_dir {
                Some(dir) => match RuntimeEngine::load(dir) {
                    Ok(engine) => engine,
                    Err(error) => {
                        let has_persisted_state = ["events.json", "snapshot.json", "mailbox.json"]
                            .iter()
                            .any(|name| std::path::Path::new(dir).join(name).exists());
                        if has_persisted_state {
                            return Err(format!(
                                "failed to load authoritative runtime state: {error}"
                            ));
                        }
                        RuntimeEngine::new().with_state_dir(dir)
                    }
                },
                None => RuntimeEngine::new(),
            };

            let command: RuntimeCommand =
                serde_json::from_str(json_input).map_err(|e| format!("invalid JSON: {e}"))?;
            let event = engine.process(command).map_err(|e| e.to_string())?;

            if compact {
                engine.compact();
            }

            if state_dir.is_some() {
                engine
                    .persist()
                    .map_err(|e| format!("persist failed: {e}"))?;
                engine
                    .write_compatibility_view()
                    .map_err(|e| format!("compatibility view failed: {e}"))?;
            }

            println!(
                "{}",
                serde_json::to_string_pretty(&event).map_err(|e| e.to_string())?
            );
            Ok(())
        }
        Some("fs-rename-no-replace") => run_fs_rename_no_replace(&args[1..]),
        Some("process-identity") => run_process_identity(&args[1..]),
        Some("init") => {
            let dir = second.ok_or("init requires a state directory path")?;
            let engine = RuntimeEngine::new().with_state_dir(dir);
            engine.persist().map_err(|e| e.to_string())?;
            println!("initialized state directory: {dir}");
            Ok(())
        }
        Some(other) => Err(format!("unknown subcommand `{other}`")),
    }
}

#[derive(Debug, Clone, Copy)]
enum FsRenameOutcome {
    Moved,
    NotMoved,
    Unsupported(&'static str),
}

fn run_fs_rename_no_replace(args: &[String]) -> Result<(), String> {
    if args.len() != 2 {
        return Err("fs-rename-no-replace requires exactly <from> and <to> paths".to_string());
    }

    let from = validate_absolute_path(&args[0], "from")?;
    let to = validate_absolute_path(&args[1], "to")?;
    let outcome = fs_rename_no_replace(&from, &to)?;
    let json = match outcome {
        FsRenameOutcome::Moved => serde_json::json!({ "outcome": "moved" }),
        FsRenameOutcome::NotMoved => {
            serde_json::json!({ "outcome": "not-moved", "code": "EEXIST" })
        }
        FsRenameOutcome::Unsupported(code) => {
            serde_json::json!({ "outcome": "unsupported", "code": code })
        }
    };
    println!(
        "{}",
        serde_json::to_string(&json).map_err(|error| error.to_string())?
    );
    Ok(())
}

fn validate_absolute_path(raw: &str, name: &str) -> Result<std::ffi::CString, String> {
    if raw.is_empty() {
        return Err(format!("{name} path must be a non-empty absolute path"));
    }
    if !std::path::Path::new(raw).is_absolute() {
        return Err(format!("{name} path must be absolute"));
    }
    std::ffi::CString::new(raw.as_bytes())
        .map_err(|_| format!("{name} path contains an embedded NUL byte"))
}

#[cfg(all(target_os = "linux", not(target_env = "musl")))]
fn fs_rename_no_replace(
    from: &std::ffi::CString,
    to: &std::ffi::CString,
) -> Result<FsRenameOutcome, String> {
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        return Ok(FsRenameOutcome::Moved);
    }

    let error = std::io::Error::last_os_error();
    match error.raw_os_error() {
        Some(libc::EEXIST) => Ok(FsRenameOutcome::NotMoved),
        Some(libc::ENOSYS) => Ok(FsRenameOutcome::Unsupported("ENOSYS")),
        Some(libc::EINVAL) => Ok(FsRenameOutcome::Unsupported("EINVAL")),
        Some(libc::ENOTSUP) => Ok(FsRenameOutcome::Unsupported("ENOTSUP")),
        Some(code) => Err(format!("renameat2 failed with errno {code}: {error}")),
        None => Err(format!("renameat2 failed: {error}")),
    }
}

#[cfg(all(target_os = "linux", target_env = "musl"))]
fn fs_rename_no_replace(
    from: &std::ffi::CString,
    to: &std::ffi::CString,
) -> Result<FsRenameOutcome, String> {
    // libc 0.2.189 added a musl binding for renameat2, but the release
    // runner's older musl exported symbol surface does not include it,
    // causing an undefined-symbol link failure. Invoke the syscall
    // directly via libc::syscall so the atomic no-replace rename works
    // regardless of the musl version. The outcome and errno mapping are
    // equivalent to the libc::renameat2 wrapper above (both classify the
    // same errno values to the same FsRenameOutcome variants).
    let result = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        return Ok(FsRenameOutcome::Moved);
    }

    let error = std::io::Error::last_os_error();
    match error.raw_os_error() {
        Some(libc::EEXIST) => Ok(FsRenameOutcome::NotMoved),
        Some(libc::ENOSYS) => Ok(FsRenameOutcome::Unsupported("ENOSYS")),
        Some(libc::EINVAL) => Ok(FsRenameOutcome::Unsupported("EINVAL")),
        Some(libc::ENOTSUP) => Ok(FsRenameOutcome::Unsupported("ENOTSUP")),
        Some(code) => Err(format!("renameat2 failed with errno {code}: {error}")),
        None => Err(format!("renameat2 failed: {error}")),
    }
}

#[cfg(target_os = "macos")]
fn fs_rename_no_replace(
    from: &std::ffi::CString,
    to: &std::ffi::CString,
) -> Result<FsRenameOutcome, String> {
    let result = unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) };
    if result == 0 {
        return Ok(FsRenameOutcome::Moved);
    }

    let error = std::io::Error::last_os_error();
    match error.raw_os_error() {
        Some(libc::EEXIST) => Ok(FsRenameOutcome::NotMoved),
        Some(libc::ENOSYS) => Ok(FsRenameOutcome::Unsupported("ENOSYS")),
        Some(libc::EINVAL) | Some(libc::ENOTSUP) => Ok(FsRenameOutcome::Unsupported("ENOTSUP")),
        Some(code) => Err(format!("renamex_np failed with errno {code}: {error}")),
        None => Err(format!("renamex_np failed: {error}")),
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn fs_rename_no_replace(
    _from: &std::ffi::CString,
    _to: &std::ffi::CString,
) -> Result<FsRenameOutcome, String> {
    Ok(FsRenameOutcome::Unsupported("platform"))
}

// ---------------------------------------------------------------------------
// process-identity subcommand
// ---------------------------------------------------------------------------

#[allow(dead_code)]
enum ProcessIdentityError {
    Denied,
    Gone,
    Unsupported,
    Error(String),
}

struct ProcessIdentityResult {
    platform: &'static str,
    birth: String,
    cmdline: Option<String>,
}

fn run_process_identity(args: &[String]) -> Result<(), String> {
    if args.len() != 1 {
        return Err("process-identity requires exactly <pid>".to_string());
    }
    let pid: u32 = args[0].parse().map_err(|_| {
        format!(
            "process-identity pid must be a positive integer, got: {}",
            args[0]
        )
    })?;
    if pid == 0 {
        return Err("process-identity pid must be > 0".to_string());
    }
    let result = process_identity(pid);
    let json = match result {
        Ok(identity) => {
            let mut obj = serde_json::json!({
                "platform": identity.platform,
                "birth": identity.birth,
            });
            if let Some(cmdline) = &identity.cmdline {
                obj["cmdline"] = serde_json::Value::String(cmdline.clone());
            }
            obj
        }
        Err(ProcessIdentityError::Denied) => {
            serde_json::json!({ "outcome": "denied" })
        }
        Err(ProcessIdentityError::Gone) => {
            serde_json::json!({ "outcome": "gone" })
        }
        Err(ProcessIdentityError::Unsupported) => {
            serde_json::json!({ "outcome": "unsupported" })
        }
        Err(ProcessIdentityError::Error(reason)) => {
            serde_json::json!({ "outcome": "error", "reason": reason })
        }
    };
    println!(
        "{}",
        serde_json::to_string(&json).map_err(|error| error.to_string())?
    );
    Ok(())
}

#[cfg(target_os = "linux")]
fn process_identity(pid: u32) -> Result<ProcessIdentityResult, ProcessIdentityError> {
    let stat_path = format!("/proc/{pid}/stat");
    let stat_content = match std::fs::read_to_string(&stat_path) {
        Ok(content) => content,
        Err(e) => {
            return match e.raw_os_error() {
                Some(libc::ENOENT) | Some(libc::ESRCH) => Err(ProcessIdentityError::Gone),
                Some(libc::EACCES) | Some(libc::EPERM) => Err(ProcessIdentityError::Denied),
                _ => Err(ProcessIdentityError::Error(format!(
                    "read stat failed: {e}"
                ))),
            };
        }
    };

    // Parse field 22: skip past the comm field (in parens) then count fields
    let command_end = stat_content.rfind(')');
    let start_ticks = match command_end {
        Some(idx) => {
            let fields: Vec<&str> = stat_content[idx + 1..].split_whitespace().collect();
            // After ')', field 1 is state, field 2 is ppid, ..., field 20 is starttime
            // (field 3 in the full stat is ppid; the 20th field after ')' is starttime)
            if fields.len() <= 19 {
                return Err(ProcessIdentityError::Error(
                    "stat content too short for starttime field".to_string(),
                ));
            }
            match fields[19].parse::<u64>() {
                Ok(v) => v,
                Err(_) => {
                    return Err(ProcessIdentityError::Error(format!(
                        "starttime field is not a valid integer: {}",
                        fields[19]
                    )))
                }
            }
        }
        None => {
            return Err(ProcessIdentityError::Error(
                "stat content has no closing paren".to_string(),
            ))
        }
    };

    // Read cmdline if accessible
    let cmdline = read_linux_cmdline(pid);

    Ok(ProcessIdentityResult {
        platform: "linux",
        birth: start_ticks.to_string(),
        cmdline,
    })
}

#[cfg(target_os = "linux")]
fn read_linux_cmdline(pid: u32) -> Option<String> {
    use std::io::Read;
    let cmdline_path = format!("/proc/{pid}/cmdline");
    let mut content = String::new();
    let result =
        std::fs::File::open(&cmdline_path).and_then(|mut f| f.read_to_string(&mut content));
    match result {
        Ok(_) => {
            let text = content.replace('\u{0}', " ").trim().to_string();
            if text.is_empty() {
                None
            } else {
                Some(text)
            }
        }
        Err(_) => None,
    }
}

// Darwin: proc_pidinfo with PROC_PIDTBSDINFO for pbi_start_tvsec/pbi_start_tvusec
#[cfg(target_os = "macos")]
fn process_identity(pid: u32) -> Result<ProcessIdentityResult, ProcessIdentityError> {
    // Use libc's maintained Darwin ABI definition instead of a partial local
    // prefix. PROC_PIDTBSDINFO requires a full proc_bsdinfo-sized buffer.
    let mut process_info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let buffer_size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    let bytes_read = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            libc::PROC_PIDTBSDINFO,
            0,
            &mut process_info as *mut _ as *mut libc::c_void,
            buffer_size,
        )
    };

    if bytes_read <= 0 {
        let errno_val = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
        return match errno_val {
            libc::EPERM | libc::EACCES => Err(ProcessIdentityError::Denied),
            libc::ESRCH | libc::ENOENT => Err(ProcessIdentityError::Gone),
            _ => Err(ProcessIdentityError::Error(format!(
                "proc_pidinfo(PROC_PIDTBSDINFO) failed: errno={}",
                errno_val
            ))),
        };
    }
    if bytes_read != buffer_size {
        return Err(ProcessIdentityError::Error(format!(
            "proc_pidinfo(PROC_PIDTBSDINFO) returned {bytes_read} bytes; expected {buffer_size}"
        )));
    }

    // Birth is exact decimal string: seconds.microseconds since Unix epoch.
    // Two processes started in the same second will differ in microseconds
    // unless they genuinely started at the same microsecond instant.
    let birth = format!(
        "{}.{}",
        process_info.pbi_start_tvsec, process_info.pbi_start_tvusec
    );

    Ok(ProcessIdentityResult {
        platform: "darwin",
        birth,
        cmdline: None,
    })
}

// Windows: OpenProcess + GetProcessTimes for creation FILETIME
#[cfg(target_os = "windows")]
fn process_identity(pid: u32) -> Result<ProcessIdentityResult, ProcessIdentityError> {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME};
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        let err = unsafe { windows_sys::Win32::Foundation::GetLastError() };
        return match err {
            5 => Err(ProcessIdentityError::Denied), // ERROR_ACCESS_DENIED
            87 => Err(ProcessIdentityError::Gone),  // ERROR_INVALID_PARAMETER
            _ => Err(ProcessIdentityError::Error(format!(
                "OpenProcess failed: error code {}",
                err
            ))),
        };
    }

    // RAII guard: CloseHandle on all paths
    struct HandleGuard(*mut std::ffi::c_void);
    impl Drop for HandleGuard {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CloseHandle(self.0) };
            }
        }
    }
    let _guard = HandleGuard(handle);

    let mut creation: FILETIME = unsafe { std::mem::zeroed() };
    let mut exit: FILETIME = unsafe { std::mem::zeroed() };
    let mut kernel: FILETIME = unsafe { std::mem::zeroed() };
    let mut user: FILETIME = unsafe { std::mem::zeroed() };

    let ok = unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) };

    if ok == 0 {
        let err = unsafe { windows_sys::Win32::Foundation::GetLastError() };
        return Err(ProcessIdentityError::Error(format!(
            "GetProcessTimes failed: error code {}",
            err
        )));
    }

    // Combine FILETIME (100ns intervals since 1601-01-01) into u64
    let birth_u64 = ((creation.dwHighDateTime as u64) << 32) | (creation.dwLowDateTime as u64);

    Ok(ProcessIdentityResult {
        platform: "win32",
        birth: birth_u64.to_string(),
        cmdline: None,
    })
}

// Unsupported platform fallback
#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn process_identity(_pid: u32) -> Result<ProcessIdentityResult, ProcessIdentityError> {
    Err(ProcessIdentityError::Unsupported)
}

fn print_usage() {
    println!(concat!(
        "usage: omx-runtime <command> [options]\n",
        "\n",
        "commands:\n",
        "  schema [--json]                     print the runtime contract summary\n",
        "  fs-rename-no-replace <from> <to>       atomically move without replacing destination\n",
        "  process-identity <pid>              print process birth identity as JSON\n",
        "  snapshot [--json] [--state-dir=DIR]  print a runtime snapshot\n",
        "  mux-contract                        print the mux boundary summary\n",
        "  exec <json> [--state-dir=DIR]       process a runtime command from JSON\n",
        "  init <state-dir>                    initialize a fresh state directory\n",
    ));
}
