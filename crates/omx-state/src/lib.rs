use std::path::{Path, PathBuf};

use omx_types::OmxError;
use serde::de::DeserializeOwned;
use serde::Serialize;

// ---------------------------------------------------------------------------
// StateStore trait (spec section 4.4)
// ---------------------------------------------------------------------------

#[async_trait::async_trait]
pub trait StateStore: Send + Sync {
    async fn read<T: DeserializeOwned + Send>(&self, path: &Path) -> Result<Option<T>, OmxError>;
    async fn write<T: Serialize + Send + Sync>(
        &self,
        path: &Path,
        value: &T,
    ) -> Result<(), OmxError>;
    async fn delete(&self, path: &Path) -> Result<(), OmxError>;
    async fn list(&self, dir: &Path) -> Result<Vec<PathBuf>, OmxError>;
    async fn append_jsonl<T: Serialize + Send + Sync>(
        &self,
        path: &Path,
        entry: &T,
    ) -> Result<(), OmxError>;
}

// ---------------------------------------------------------------------------
// FileStateStore (skeleton — atomic rename + fs2 locking)
// ---------------------------------------------------------------------------

pub struct FileStateStore {
    root: PathBuf,
}

impl FileStateStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Resolve a relative path against the store root.
    pub fn resolve(&self, path: &Path) -> PathBuf {
        self.root.join(path)
    }
}

#[async_trait::async_trait]
impl StateStore for FileStateStore {
    async fn read<T: DeserializeOwned + Send>(&self, _path: &Path) -> Result<Option<T>, OmxError> {
        todo!("Phase 1: atomic read with fs2 shared lock")
    }

    async fn write<T: Serialize + Send + Sync>(
        &self,
        _path: &Path,
        _value: &T,
    ) -> Result<(), OmxError> {
        todo!("Phase 1: temp file + atomic rename with fs2 exclusive lock")
    }

    async fn delete(&self, _path: &Path) -> Result<(), OmxError> {
        todo!("Phase 1: remove file if exists")
    }

    async fn list(&self, _dir: &Path) -> Result<Vec<PathBuf>, OmxError> {
        todo!("Phase 1: list directory entries")
    }

    async fn append_jsonl<T: Serialize + Send + Sync>(
        &self,
        _path: &Path,
        _entry: &T,
    ) -> Result<(), OmxError> {
        todo!("Phase 1: append JSON line with exclusive lock")
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_state_store_resolves_paths() {
        let store = FileStateStore::new(PathBuf::from("/tmp/omx-state"));
        assert_eq!(
            store.resolve(Path::new("team/config.json")),
            PathBuf::from("/tmp/omx-state/team/config.json")
        );
    }

    #[ignore]
    #[tokio::test]
    async fn write_then_read_roundtrip() {
        // Phase 1: write a value, read it back, assert equality
    }

    #[ignore]
    #[tokio::test]
    async fn atomic_write_survives_concurrent_reads() {
        // Phase 1: spawn concurrent readers + one writer, assert no partial reads
    }

    #[ignore]
    #[tokio::test]
    async fn append_jsonl_preserves_existing_entries() {
        // Phase 1: append multiple entries, read file, assert all present
    }
}
