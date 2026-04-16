//! `.ive/config.toml` loader with safe defaults.

use serde::{Deserialize, Serialize};
use std::path::Path;

/// Runtime-tunable weights. Defaults mirror `spec §6`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthWeights {
    #[serde(default = "default_novelty")]
    pub novelty: f32,
    #[serde(default = "default_cognitive_complexity")]
    pub cognitive_complexity: f32,
    #[serde(default = "default_coupling")]
    pub coupling: f32,
    #[serde(default = "default_ai_signal")]
    pub ai_signal: f32,
}

fn default_novelty() -> f32 { 0.2 }
fn default_cognitive_complexity() -> f32 { 0.3 }
fn default_coupling() -> f32 { 0.2 }
fn default_ai_signal() -> f32 { 0.3 }

impl Default for HealthWeights {
    fn default() -> Self {
        Self {
            novelty: default_novelty(),
            cognitive_complexity: default_cognitive_complexity(),
            coupling: default_coupling(),
            ai_signal: default_ai_signal(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Config {
    #[serde(default)]
    pub health: HealthWeights,
    #[serde(default)]
    pub ignore: Vec<String>,
}

impl Config {
    pub fn load(workspace: &Path) -> anyhow::Result<Self> {
        let path = workspace.join(".ive").join("config.toml");
        if !path.exists() {
            return Ok(Self::default());
        }
        let text = std::fs::read_to_string(&path)?;
        let cfg: Self = toml::from_str(&text)?;
        Ok(cfg)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_sum_to_one() {
        let w = HealthWeights::default();
        let sum = w.novelty + w.cognitive_complexity + w.coupling + w.ai_signal;
        assert!((sum - 1.0).abs() < 1e-6, "weights must sum to 1: {sum}");
    }

    #[test]
    fn missing_file_uses_defaults() {
        let tmp = std::env::temp_dir().join(format!("ive-cfg-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let cfg = Config::load(&tmp).unwrap();
        assert!((cfg.health.novelty - 0.2).abs() < 1e-6);
        std::fs::remove_dir_all(&tmp).ok();
    }
}
