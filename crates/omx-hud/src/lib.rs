use omx_types::TeamPhase;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HudState {
    pub session_id: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub team_phase: Option<TeamPhase>,
    pub worker_count: u32,
    pub pending_tasks: u32,
    pub completed_tasks: u32,
    pub uptime_seconds: u64,
}

impl Default for HudState {
    fn default() -> Self {
        Self {
            session_id: None,
            provider: None,
            model: None,
            team_phase: None,
            worker_count: 0,
            pending_tasks: 0,
            completed_tasks: 0,
            uptime_seconds: 0,
        }
    }
}

pub async fn run_hud(_initial_state: HudState) -> Result<(), Box<dyn std::error::Error>> {
    todo!("Phase 4: ratatui event loop with crossterm backend, render widgets, listen for state updates via channel")
}

pub fn render_frame(
    _state: &HudState,
    _frame: &mut ratatui::Frame,
    _area: ratatui::layout::Rect,
) {
    todo!("Phase 4: render HUD widgets — header, team status, task list, worker grid")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hud_state_default_is_idle() {
        let state = HudState::default();
        assert!(state.session_id.is_none());
        assert_eq!(state.worker_count, 0);
    }

    #[test]
    fn hud_state_serde_roundtrip() {
        let state = HudState {
            session_id: Some("sess-1".into()),
            provider: Some("codex".into()),
            model: Some("o3".into()),
            team_phase: Some(TeamPhase::Exec),
            worker_count: 3,
            pending_tasks: 5,
            completed_tasks: 2,
            uptime_seconds: 120,
        };
        let json = serde_json::to_string(&state).unwrap();
        let parsed: HudState = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.worker_count, 3);
    }

    #[ignore]
    #[test]
    fn render_frame_placeholder() {
        // Phase 4: test render with TestBackend
    }
}
