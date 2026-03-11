use std::fmt;
use std::io;

#[derive(Debug)]
pub enum SparkshellError {
    InvalidArgs(String),
    Io(io::Error),
    SummaryTimeout(u64),
    SummaryBridge(String),
}

impl fmt::Display for SparkshellError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SparkshellError::InvalidArgs(message) => write!(f, "{message}"),
            SparkshellError::Io(error) => write!(f, "{error}"),
            SparkshellError::SummaryTimeout(timeout_ms) => {
                write!(f, "codex summary timed out after {timeout_ms}ms")
            }
            SparkshellError::SummaryBridge(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for SparkshellError {}

impl From<io::Error> for SparkshellError {
    fn from(value: io::Error) -> Self {
        SparkshellError::Io(value)
    }
}

impl SparkshellError {
    pub fn raw_exit_code(&self) -> i32 {
        match self {
            SparkshellError::InvalidArgs(_) => 2,
            SparkshellError::Io(error) => match error.kind() {
                io::ErrorKind::NotFound => 127,
                io::ErrorKind::PermissionDenied => 126,
                _ => 1,
            },
            SparkshellError::SummaryTimeout(_) | SparkshellError::SummaryBridge(_) => 1,
        }
    }
}
