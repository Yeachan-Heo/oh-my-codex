use fs2::FileExt;
use serde_json::Value;
use std::io::{self, BufRead, Write};
#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const LOCK_TIMEOUT: Duration = Duration::from_secs(34);
const SAFE_LEAF_SUFFIX: &str = ".mutex";

pub fn run(args: &[String]) -> Result<(), String> {
    if args.len() != 4 {
        return Err("lease-mutex requires exactly <absolute-canonical-dir> <expected-dev> <expected-ino> <safe-leaf>".to_string());
    }
    let leaf = validate_safe_leaf(&args[3])?;
    #[cfg(unix)]
    {
        let dir = PathBuf::from(&args[0]);
        if !dir.is_absolute() {
            return emit_startup_error("lease-mutex directory must be absolute".to_string());
        }
        let expected_dev = match parse_identity(&args[1], "expected-dev") {
            Ok(value) => value,
            Err(error) => return emit_startup_error(error),
        };
        let expected_ino = match parse_identity(&args[2], "expected-ino") {
            Ok(value) => value,
            Err(error) => return emit_startup_error(error),
        };
        let lease = match UnixLease::open(&dir, expected_dev, expected_ino, leaf) {
            Ok(lease) => lease,
            Err(error) => return emit_startup_error(error),
        };
        run_protocol(lease)
    }
    #[cfg(not(unix))]
    {
        let _ = args;
        Err("lease-mutex unsupported on this platform; native no-follow identity semantics are unavailable".to_string())
    }
}

fn validate_safe_leaf(raw: &str) -> Result<String, String> {
    let valid_hex = raw.strip_suffix(SAFE_LEAF_SUFFIX).is_some_and(|key| {
        key.len() == 64
            && key
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    });
    if !valid_hex {
        return Err("lease-mutex safe-leaf must match ^[a-f0-9]{64}\\.mutex$".to_string());
    }
    Ok(raw.to_string())
}

fn parse_identity(raw: &str, name: &str) -> Result<u64, String> {
    raw.parse::<u64>()
        .map_err(|_| format!("{name} must be a non-negative decimal integer"))
}

fn run_protocol<L: Lease>(mut lease: L) -> Result<(), String> {
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    write_json(
        &mut stdout,
        serde_json::json!({"id":0,"ok":true,"ready":true}),
    )?;
    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let line = line.map_err(|e| format!("stdin read failed: {e}"))?;
        if line.trim().is_empty() {
            continue;
        }
        let request: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(error) => {
                write_json(
                    &mut stdout,
                    serde_json::json!({"id":null,"ok":false,"error":format!("invalid JSON request: {error}")}),
                )?;
                continue;
            }
        };
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let op = request.get("op").and_then(Value::as_str);
        match op {
            Some("assert") => match lease.verify() {
                Ok(()) => write_json(&mut stdout, serde_json::json!({"id":id,"ok":true}))?,
                Err(error) => write_json(
                    &mut stdout,
                    serde_json::json!({"id":id,"ok":false,"error":error}),
                )?,
            },
            Some("close") => match lease.verify() {
                Ok(()) => {
                    lease.release()?;
                    write_json(&mut stdout, serde_json::json!({"id":id,"ok":true}))?;
                    return Ok(());
                }
                Err(error) => {
                    let release_error = lease.release().err();
                    let message = match release_error {
                        Some(release_error) => format!("{error}; {release_error}"),
                        None => error,
                    };
                    write_json(
                        &mut stdout,
                        serde_json::json!({"id":id,"ok":false,"error":message}),
                    )?;
                    return Ok(());
                }
            },
            Some(other) => write_json(
                &mut stdout,
                serde_json::json!({"id":id,"ok":false,"error":format!("unsupported lease-mutex operation: {other}")}),
            )?,
            None => write_json(
                &mut stdout,
                serde_json::json!({"id":id,"ok":false,"error":"request op must be assert or close"}),
            )?,
        }
    }
    Ok(())
}

fn write_json(out: &mut impl Write, value: Value) -> Result<(), String> {
    serde_json::to_writer(&mut *out, &value)
        .map_err(|e| format!("stdout JSON write failed: {e}"))?;
    out.write_all(b"\n")
        .map_err(|e| format!("stdout write failed: {e}"))?;
    out.flush().map_err(|e| format!("stdout flush failed: {e}"))
}

fn emit_startup_error(error: String) -> Result<(), String> {
    let mut stdout = io::stdout().lock();
    let _ = write_json(
        &mut stdout,
        serde_json::json!({"id":0,"ok":false,"error":error}),
    );
    Err(error)
}

trait Lease {
    fn verify(&self) -> Result<(), String>;
    fn release(&mut self) -> Result<(), String>;
}

#[cfg(unix)]
struct UnixLease {
    dir: std::fs::File,
    mutex: std::fs::File,
    dir_path: PathBuf,
    expected_dev: u64,
    expected_ino: u64,
    mutex_dev: u64,
    mutex_ino: u64,
    leaf: String,
    held: bool,
}

#[cfg(unix)]
impl UnixLease {
    fn open(
        path: &Path,
        expected_dev: u64,
        expected_ino: u64,
        leaf: String,
    ) -> Result<Self, String> {
        std::fs::canonicalize(path)
            .map_err(|e| format!("lease-mutex cannot canonicalize directory: {e}"))?;
        let dir = open_directory(path)?;
        let dir_identity = stat_fd(dir.as_raw_fd(), "pinned directory")?;
        if !dir_identity.is_dir {
            return Err("lease-mutex path is not a directory".to_string());
        }
        if dir_identity.dev != expected_dev || dir_identity.ino != expected_ino {
            return Err(format!("lease-mutex directory identity mismatch: expected dev={expected_dev} ino={expected_ino}, got dev={} ino={}", dir_identity.dev, dir_identity.ino));
        }
        let mutex = open_mutex(dir.as_raw_fd(), &leaf)?;
        let mutex_identity = stat_fd(mutex.as_raw_fd(), "mutex file")?;
        if !mutex_identity.is_regular || mutex_identity.nlink != 1 {
            return Err(
                "lease-mutex mutex leaf must be a regular file with link count 1".to_string(),
            );
        }
        try_lock(&mutex)?;
        let lease = Self {
            dir,
            mutex,
            dir_path: path.to_path_buf(),
            expected_dev,
            expected_ino,
            mutex_dev: mutex_identity.dev,
            mutex_ino: mutex_identity.ino,
            leaf,
            held: true,
        };
        lease.verify()?;
        Ok(lease)
    }
}

#[cfg(unix)]
impl Lease for UnixLease {
    fn verify(&self) -> Result<(), String> {
        if !self.held {
            return Err("lease-mutex lock is no longer held".to_string());
        }
        let pinned = stat_fd(self.dir.as_raw_fd(), "pinned directory")?;
        if !pinned.is_dir || pinned.dev != self.expected_dev || pinned.ino != self.expected_ino {
            return Err("lease-mutex pinned directory identity changed".to_string());
        }
        let visible = stat_at(self.dir.as_raw_fd(), &self.leaf)?;
        if !visible.is_regular || visible.nlink != 1 {
            return Err("lease-mutex visible mutex leaf is not a regular nlink-1 file".to_string());
        }
        if visible.dev != self.mutex_dev || visible.ino != self.mutex_ino {
            return Err("lease-mutex visible mutex identity changed".to_string());
        }
        let opened = stat_fd(self.mutex.as_raw_fd(), "opened mutex")?;
        if !opened.is_regular
            || opened.nlink != 1
            || opened.dev != self.mutex_dev
            || opened.ino != self.mutex_ino
        {
            return Err("lease-mutex opened mutex identity changed".to_string());
        }
        let path_identity = stat_path(&self.dir_path)?;
        if path_identity.dev != self.expected_dev || path_identity.ino != self.expected_ino {
            return Err("lease-mutex directory path identity changed".to_string());
        }
        Ok(())
    }

    fn release(&mut self) -> Result<(), String> {
        if self.held {
            FileExt::unlock(&self.mutex).map_err(|e| format!("lease-mutex unlock failed: {e}"))?;
            self.held = false;
        }
        Ok(())
    }
}

#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd};

#[cfg(unix)]
#[derive(Clone, Copy)]
struct Identity {
    dev: u64,
    ino: u64,
    nlink: u64,
    is_dir: bool,
    is_regular: bool,
}

#[cfg(unix)]
fn open_directory(path: &Path) -> Result<std::fs::File, String> {
    let c = cstring(path, "directory")?;
    let fd = unsafe {
        libc::open(
            c.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if fd < 0 {
        return Err(format!(
            "lease-mutex cannot open directory without following symlinks: {}",
            io::Error::last_os_error()
        ));
    }
    Ok(unsafe { std::fs::File::from_raw_fd(fd) })
}

#[cfg(unix)]
fn open_mutex(dir_fd: i32, leaf_name: &str) -> Result<std::fs::File, String> {
    let leaf = std::ffi::CString::new(leaf_name)
        .map_err(|_| "lease-mutex safe-leaf contains NUL".to_string())?;
    let flags = libc::O_RDWR | libc::O_CLOEXEC | libc::O_NOFOLLOW;
    let mut fd = unsafe { libc::openat(dir_fd, leaf.as_ptr(), flags) };
    if fd < 0 && io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT) {
        fd = unsafe {
            libc::openat(
                dir_fd,
                leaf.as_ptr(),
                flags | libc::O_CREAT | libc::O_EXCL,
                0o600,
            )
        };
        if fd < 0 && io::Error::last_os_error().raw_os_error() == Some(libc::EEXIST) {
            fd = unsafe { libc::openat(dir_fd, leaf.as_ptr(), flags) };
        }
    }
    if fd < 0 {
        return Err(format!(
            "lease-mutex cannot open permanent mutex leaf without following symlinks: {}",
            io::Error::last_os_error()
        ));
    }
    Ok(unsafe { std::fs::File::from_raw_fd(fd) })
}

#[cfg(unix)]
fn try_lock(file: &std::fs::File) -> Result<(), String> {
    let start = Instant::now();
    loop {
        match file.try_lock_exclusive() {
            Ok(()) => return Ok(()),
            Err(error)
                if error.kind() == io::ErrorKind::WouldBlock && start.elapsed() < LOCK_TIMEOUT =>
            {
                std::thread::sleep(Duration::from_millis(20))
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                return Err(format!(
                    "lease-mutex lock acquisition timed out after {} ms",
                    LOCK_TIMEOUT.as_millis()
                ))
            }
            Err(error) => return Err(format!("lease-mutex lock acquisition failed: {error}")),
        }
    }
}

#[cfg(unix)]
fn cstring(path: &Path, label: &str) -> Result<std::ffi::CString, String> {
    std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| format!("lease-mutex {label} path contains an embedded NUL byte"))
}

#[cfg(unix)]
fn stat_path(path: &Path) -> Result<Identity, String> {
    let c = cstring(path, "directory")?;
    let mut st = unsafe { std::mem::zeroed() };
    if unsafe { libc::lstat(c.as_ptr(), &mut st) } != 0 {
        return Err(format!(
            "lease-mutex cannot verify directory path: {}",
            io::Error::last_os_error()
        ));
    }
    Ok(identity_from_stat(&st))
}

#[cfg(unix)]
fn stat_at(dir_fd: i32, leaf: &str) -> Result<Identity, String> {
    let c = std::ffi::CString::new(leaf).unwrap();
    let mut st = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstatat(dir_fd, c.as_ptr(), &mut st, libc::AT_SYMLINK_NOFOLLOW) } != 0 {
        return Err(format!(
            "lease-mutex cannot verify visible mutex leaf: {}",
            io::Error::last_os_error()
        ));
    }
    Ok(identity_from_stat(&st))
}

#[cfg(unix)]
fn stat_fd(fd: i32, label: &str) -> Result<Identity, String> {
    let mut st = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(fd, &mut st) } != 0 {
        return Err(format!(
            "lease-mutex cannot stat {label}: {}",
            io::Error::last_os_error()
        ));
    }
    Ok(identity_from_stat(&st))
}

#[cfg(unix)]
#[allow(clippy::unnecessary_cast)]
fn identity_from_stat(st: &libc::stat) -> Identity {
    Identity {
        dev: st.st_dev as u64,
        ino: st.st_ino as u64,
        nlink: st.st_nlink as u64,
        is_dir: (st.st_mode & libc::S_IFMT) == libc::S_IFDIR,
        is_regular: (st.st_mode & libc::S_IFMT) == libc::S_IFREG,
    }
}
