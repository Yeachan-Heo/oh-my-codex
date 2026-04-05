use std::io::{self, Read};
use omx_types::HookEvent;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;

    let _event: HookEvent = serde_json::from_str(&input)?;

    // Phase 5: send Slack webhook notification
    let result = serde_json::json!({
        "hook": "omx-notify-slack",
        "success": false,
        "stdout": "",
        "stderr": "not implemented",
        "duration_ms": 0
    });

    println!("{}", serde_json::to_string(&result)?);
    Ok(())
}
