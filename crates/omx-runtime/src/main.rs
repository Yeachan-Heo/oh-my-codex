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

fn print_usage() {
    println!(concat!(
        "usage: omx-runtime <command> [options]\n",
        "\n",
        "commands:\n",
        "  schema [--json]                     print the runtime contract summary\n",
        "  snapshot [--json] [--state-dir=DIR]  print a runtime snapshot\n",
        "  mux-contract                        print the mux boundary summary\n",
        "  exec <json> [--state-dir=DIR]       process a runtime command from JSON\n",
        "  init <state-dir>                    initialize a fresh state directory\n",
    ));
}
