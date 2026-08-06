//! Unix domain socket listener implementation.

use std::fs;
use std::io::{Read, Write};
use std::os::unix::net::UnixListener;
use std::path::PathBuf;

use crate::listener::{ensure_private_parent, Endpoint, ListenerError};

pub(crate) struct UnixListenerImpl {
    listener: UnixListener,
    socket_path: PathBuf,
}

impl UnixListenerImpl {
    pub(crate) fn bind(endpoint: &Endpoint) -> Result<Self, ListenerError> {
        let Endpoint::UnixSocket(socket_path) = endpoint else {
            return Err(ListenerError::new("only unix:// endpoints are supported on this platform"));
        };

        // If the caller gave us a directory, place the socket inside it.
        let socket_path = if socket_path.is_dir() || socket_path.as_os_str().is_empty() {
            return Err(ListenerError::new("unix socket endpoint must be a file path"));
        } else {
            socket_path.clone()
        };

        ensure_private_parent(&socket_path)?;

        // Remove any stale socket file.
        let _ = fs::remove_file(&socket_path);

        let listener = UnixListener::bind(&socket_path)
            .map_err(|e| ListenerError::io(e, "binding unix socket"))?;

        Ok(Self {
            listener,
            socket_path,
        })
    }

    pub(crate) fn accept(&self) -> Result<(Box<dyn Read + Send>, Box<dyn Write + Send>), ListenerError> {
        let (stream, _addr) = self
            .listener
            .accept()
            .map_err(|e| ListenerError::io(e, "accepting unix connection"))?;

        let read = stream.try_clone().map_err(|e| ListenerError::io(e, "cloning unix stream"))?;
        let write = stream;

        Ok((Box::new(read), Box::new(write)))
    }
}

impl Drop for UnixListenerImpl {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.socket_path);
    }
}
