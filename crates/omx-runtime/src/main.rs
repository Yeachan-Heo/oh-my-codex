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

fn print_usage() {
    println!(concat!(
        "usage: omx-runtime <command> [options]\n",
        "\n",
        "commands:\n",
        "  schema [--json]                     print the runtime contract summary\n",
        "  fs-rename-no-replace <from> <to>       atomically move without replacing destination\n",
        "  snapshot [--json] [--state-dir=DIR]  print a runtime snapshot\n",
        "  mux-contract                        print the mux boundary summary\n",
        "  exec <json> [--state-dir=DIR]       process a runtime command from JSON\n",
        "  init <state-dir>                    initialize a fresh state directory\n",
    ));
}
