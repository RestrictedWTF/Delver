//! Windows named-pipe listener implementation.
//!
//! Each pipe instance is created with a DACL that allows access only to the
//! user that created it. The unsafe code in this module is confined to Win32
//! security and pipe APIs; it does not parse or interpret RPC payloads.

#![allow(unsafe_code)]

use std::fs::File;
use std::io::{self, Read, Write};
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use windows_sys::Win32::Foundation::{
	CloseHandle, DuplicateHandle, LocalFree, FALSE, HANDLE, HLOCAL, TRUE,
};
use windows_sys::Win32::Security::{
	AddAccessAllowedAce, CopySid, GetLengthSid, GetTokenInformation, InitializeAcl,
	InitializeSecurityDescriptor, SetSecurityDescriptorDacl, TokenUser, ACL, ACL_REVISION,
	PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::Storage::FileSystem::{
	FlushFileBuffers, FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX,
};
use windows_sys::Win32::System::Memory::{LocalAlloc, LPTR};
use windows_sys::Win32::System::Pipes::{
	ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, GetNamedPipeClientProcessId,
	PeekNamedPipe, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
};
use windows_sys::Win32::System::SystemServices::SECURITY_DESCRIPTOR_REVISION;
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

use crate::listener::{
	last_error, Endpoint, ListenerError, PeerAuthenticatedDuplexStream, PeerIdentity,
	ShutdownableDuplexStream,
};

const PIPE_BUFFER_SIZE: u32 = 65536;
const GENERIC_READ: u32 = 0x80000000;
const GENERIC_WRITE: u32 = 0x40000000;

pub(crate) struct WindowsListenerImpl {
	/// The Win32 path of the named pipe, e.g. `\\.\pipe\delver-...`.
	pipe_path: String,
	/// Reserved first instance. Keeping it open prevents namespace squatting
	/// between bind/readiness and the first accept.
	first_instance: Mutex<Option<usize>>,
}

impl WindowsListenerImpl {
	pub(crate) fn connect_shutdownable(
		endpoint: &Endpoint,
	) -> Result<ShutdownableDuplexStream, ListenerError> {
		use std::os::windows::io::FromRawHandle;
		use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
		use windows_sys::Win32::Storage::FileSystem::{
			CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_NONE, OPEN_EXISTING,
		};

		let Endpoint::NamedPipe(path) = endpoint else {
			return Err(ListenerError::new(
				"only pipe:// or npipe:// endpoints are supported on Windows",
			));
		};

		let name_wide: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();

		// The server creates instances on demand in accept(). If we connect
		// before an instance is waiting, retry briefly.
		let mut handle = INVALID_HANDLE_VALUE;
		for _ in 0..50 {
			// SAFETY: `name_wide` is NUL-terminated and lives for the call; all
			// optional pointers are null, and the returned handle is checked.
			handle = unsafe {
				CreateFileW(
					name_wide.as_ptr(),
					GENERIC_READ | GENERIC_WRITE,
					FILE_SHARE_NONE,
					ptr::null(),
					OPEN_EXISTING,
					FILE_ATTRIBUTE_NORMAL,
					ptr::null_mut(),
				)
			};
			if handle != INVALID_HANDLE_VALUE {
				break;
			}
			let err = std::io::Error::last_os_error();
			if err.raw_os_error() != Some(2) {
				return Err(ListenerError::io(err, "opening named pipe"));
			}
			std::thread::sleep(std::time::Duration::from_millis(10));
		}

		if handle == INVALID_HANDLE_VALUE {
			return Err(last_error("opening named pipe"));
		}

		let read_handle = duplicate_client_handle(handle)?;
		let write_handle = duplicate_client_handle(handle)?;
		// SAFETY: `handle` was returned by CreateFileW and ownership has been
		// duplicated into `read_handle` and `write_handle`.
		unsafe {
			CloseHandle(handle);
		}

		// SAFETY: each value is a distinct owned handle returned by
		// DuplicateHandle and is transferred exactly once into `File`.
		let read_file = unsafe { File::from_raw_handle(read_handle) };
		// SAFETY: see the preceding handle-ownership argument.
		let write_file = unsafe { File::from_raw_handle(write_handle) };
		let stopped = Arc::new(AtomicBool::new(false));
		let reader_stopped = Arc::clone(&stopped);
		Ok((
			Box::new(PollingPipeReader::shutdownable(read_file, reader_stopped)),
			Box::new(write_file),
			Arc::new(move || stopped.store(true, Ordering::Release)),
		))
	}

	pub(crate) fn bind(endpoint: &Endpoint) -> Result<Self, ListenerError> {
		let Endpoint::NamedPipe(pipe_path) = endpoint else {
			return Err(ListenerError::new(
				"only pipe:// or npipe:// endpoints are supported on Windows",
			));
		};

		// Create and retain the first instance so the namespace and its ACL are
		// already authoritative when the caller publishes readiness.
		let handle = create_pipe_instance(pipe_path, FILE_FLAG_FIRST_PIPE_INSTANCE)?;

		Ok(Self {
			pipe_path: pipe_path.clone(),
			first_instance: Mutex::new(Some(handle as usize)),
		})
	}

	pub(crate) fn accept_shutdownable_with_peer(
		&self,
	) -> Result<PeerAuthenticatedDuplexStream, ListenerError> {
		let first = self
			.first_instance
			.lock()
			.map_err(|_| ListenerError::new("named-pipe first-instance lock is poisoned"))?
			.take();
		let handle = match first {
			Some(handle) => handle as HANDLE,
			None => create_pipe_instance(&self.pipe_path, 0)?,
		};

		// SAFETY: `handle` is an owned server pipe instance and the null
		// OVERLAPPED pointer requests the documented synchronous operation.
		let connected = unsafe { ConnectNamedPipe(handle, ptr::null_mut()) };
		if connected == FALSE {
			let err = std::io::Error::last_os_error();
			// ERROR_PIPE_CONNECTED (535) means the client connected before we
			// called ConnectNamedPipe; that is still a success.
			if err.raw_os_error() != Some(535) {
				// SAFETY: this error path still owns the pipe handle.
				unsafe {
					DisconnectNamedPipe(handle);
					CloseHandle(handle);
				}
				return Err(ListenerError::io(err, "waiting for pipe connection"));
			}
		}
		let mut process_id = 0;
		// SAFETY: `handle` is connected and `process_id` is a valid writable u32.
		if unsafe { GetNamedPipeClientProcessId(handle, &mut process_id) } == FALSE {
			// SAFETY: this error path still owns the pipe handle.
			unsafe {
				DisconnectNamedPipe(handle);
				CloseHandle(handle);
			}
			return Err(last_error("querying named-pipe client process"));
		}

		// Split the handle into independent read and write halves so the
		// framed transport can own them separately.
		let read_handle = duplicate_handle(handle)?;
		let write_handle = duplicate_handle(handle)?;
		let shutdown_handle = duplicate_handle(handle)?;

		// SAFETY: ownership has been duplicated into the three handles above.
		unsafe {
			CloseHandle(handle);
		}

		// SAFETY: each distinct duplicated handle is transferred exactly once.
		let read_file = unsafe { File::from_raw_handle(read_handle) };
		// SAFETY: see the preceding handle-ownership argument.
		let write_file = unsafe { File::from_raw_handle(write_handle) };
		let shutdown = Arc::new(WindowsPipeShutdown(shutdown_handle as usize));

		Ok((
			Box::new(PollingPipeReader::new(read_file)),
			Box::new(FlushingPipeWriter(write_file)),
			Arc::new(move || shutdown.disconnect()),
			PeerIdentity::new(Some(process_id), None),
		))
	}
}

/// Avoids holding a synchronous duplex pipe read while another thread needs to
/// write through a duplicated handle for the same pipe object.
struct PollingPipeReader {
	file: File,
	stopped: Arc<AtomicBool>,
}

impl PollingPipeReader {
	fn new(file: File) -> Self {
		Self::shutdownable(file, Arc::new(AtomicBool::new(false)))
	}

	fn shutdownable(file: File, stopped: Arc<AtomicBool>) -> Self {
		Self { file, stopped }
	}
}

impl Read for PollingPipeReader {
	fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
		if buffer.is_empty() {
			return Ok(0);
		}
		loop {
			if self.stopped.load(Ordering::Acquire) {
				return Ok(0);
			}
			let mut available = 0;
			// SAFETY: the file owns a live pipe handle, `available` is writable,
			// and all buffers we do not request are represented by null pointers.
			if unsafe {
				PeekNamedPipe(
					self.file.as_raw_handle(),
					ptr::null_mut(),
					0,
					ptr::null_mut(),
					&mut available,
					ptr::null_mut(),
				)
			} == FALSE
			{
				return Err(io::Error::last_os_error());
			}
			if available > 0 {
				let read = buffer.len().min(available as usize);
				return self.file.read(&mut buffer[..read]);
			}
			std::thread::sleep(std::time::Duration::from_millis(1));
		}
	}
}

struct FlushingPipeWriter(File);

impl Write for FlushingPipeWriter {
	fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
		self.0.write(buffer)
	}

	fn flush(&mut self) -> io::Result<()> {
		// SAFETY: the writer owns a live pipe handle for the duration of the call.
		if unsafe { FlushFileBuffers(self.0.as_raw_handle()) } == FALSE {
			return Err(io::Error::last_os_error());
		}
		Ok(())
	}
}

impl Drop for WindowsListenerImpl {
	fn drop(&mut self) {
		if let Ok(first) = self.first_instance.get_mut() {
			if let Some(handle) = first.take() {
				// SAFETY: the listener still owns its reserved first-instance handle.
				unsafe {
					CloseHandle(handle as HANDLE);
				}
			}
		}
	}
}

struct WindowsPipeShutdown(usize);

impl WindowsPipeShutdown {
	fn disconnect(&self) {
		// SAFETY: the shutdown object owns a live server pipe handle.
		unsafe {
			let _ = DisconnectNamedPipe(self.0 as HANDLE);
		}
	}
}

impl Drop for WindowsPipeShutdown {
	fn drop(&mut self) {
		// SAFETY: this object owns the duplicated handle and drops it once.
		unsafe {
			CloseHandle(self.0 as HANDLE);
		}
	}
}

fn create_pipe_instance(path: &str, extra_flags: u32) -> Result<HANDLE, ListenerError> {
	let name_wide: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();

	let security = create_user_only_security_attributes()?;

	// SAFETY: the path is NUL-terminated, the security attributes remain live
	// for the call, and every size/flag value follows CreateNamedPipeW's contract.
	let handle = unsafe {
		CreateNamedPipeW(
			name_wide.as_ptr(),
			PIPE_ACCESS_DUPLEX | extra_flags,
			PIPE_TYPE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
			PIPE_UNLIMITED_INSTANCES,
			PIPE_BUFFER_SIZE,
			PIPE_BUFFER_SIZE,
			0,
			ptr::addr_of!(security.attributes),
		)
	};

	// The security descriptor and ACL were allocated on the heap; free them
	// now that the kernel has copied them into the pipe object.
	// SAFETY: both pointers came from LocalAlloc and are freed exactly once
	// after CreateNamedPipeW has copied the security descriptor.
	unsafe {
		LocalFree(security.acl as HLOCAL);
		LocalFree(security.descriptor as HLOCAL);
	}

	if handle == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
		return Err(last_error("creating named pipe"));
	}

	Ok(handle)
}

struct SecurityAttributes {
	attributes: SECURITY_ATTRIBUTES,
	descriptor: PSECURITY_DESCRIPTOR,
	acl: *mut ACL,
}

fn create_user_only_security_attributes() -> Result<SecurityAttributes, ListenerError> {
	// SAFETY: every allocation and Win32 handle acquired in this block is
	// checked before dereference and released on each error path. Buffer sizes
	// come from the corresponding Win32 query or structure size, and the returned
	// descriptor/ACL remain allocated for the caller to pass to CreateNamedPipeW.
	unsafe {
		// Allocate a security descriptor. SECURITY_DESCRIPTOR_MIN_LENGTH is
		// 20 bytes; 256 bytes gives comfortable slack.
		let descriptor: PSECURITY_DESCRIPTOR = LocalAlloc(LPTR, 256) as _;
		if descriptor.is_null() {
			return Err(last_error("allocating security descriptor"));
		}

		if InitializeSecurityDescriptor(descriptor, SECURITY_DESCRIPTOR_REVISION) == FALSE {
			LocalFree(descriptor as HLOCAL);
			return Err(last_error("initializing security descriptor"));
		}

		let mut token: HANDLE = ptr::null_mut();
		if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == FALSE {
			LocalFree(descriptor as HLOCAL);
			return Err(last_error("opening process token"));
		}

		// Query the token user. First call gets the required size.
		let mut size: u32 = 0;
		let _ = GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut size);
		let user_buf = LocalAlloc(LPTR, size as usize);
		if user_buf.is_null() {
			CloseHandle(token);
			LocalFree(descriptor as HLOCAL);
			return Err(last_error("allocating token user buffer"));
		}
		if GetTokenInformation(token, TokenUser, user_buf, size, &mut size) == FALSE {
			LocalFree(user_buf as HLOCAL);
			CloseHandle(token);
			LocalFree(descriptor as HLOCAL);
			return Err(last_error("getting token user information"));
		}
		CloseHandle(token);

		// Extract the SID pointer from the TOKEN_USER struct and copy it into
		// our own allocation so we can free the token buffer.
		let user = &*(user_buf as *const TOKEN_USER);
		let sid_src: PSID = user.User.Sid;
		let sid_len = GetLengthSid(sid_src) as usize;
		let sid_copy = LocalAlloc(LPTR, sid_len);
		if sid_copy.is_null() {
			LocalFree(user_buf as HLOCAL);
			LocalFree(descriptor as HLOCAL);
			return Err(last_error("allocating SID copy"));
		}
		if CopySid(sid_len as u32, sid_copy, sid_src) == FALSE {
			LocalFree(sid_copy as HLOCAL);
			LocalFree(user_buf as HLOCAL);
			LocalFree(descriptor as HLOCAL);
			return Err(last_error("copying SID"));
		}
		LocalFree(user_buf as HLOCAL);

		// Build an ACL with one ACE: current user gets generic read/write.
		// Correct size: sizeof(ACL) + sizeof(ACCESS_ALLOWED_ACE) - sizeof(DWORD)
		// + GetLengthSid. ACCESS_ALLOWED_ACE = ACE_HEADER(4) + Mask(4) +
		// SidStart(4), so the fixed overhead is 4 + 4 = 8 bytes.
		let acl_size = std::mem::size_of::<ACL>() as u32 + 8 + sid_len as u32;
		let acl = LocalAlloc(LPTR, acl_size as usize) as *mut ACL;
		if acl.is_null() {
			LocalFree(sid_copy as HLOCAL);
			LocalFree(descriptor as HLOCAL);
			return Err(last_error("allocating ACL"));
		}

		if InitializeAcl(acl, acl_size, ACL_REVISION) == FALSE {
			LocalFree(acl as HLOCAL);
			LocalFree(sid_copy as HLOCAL);
			LocalFree(descriptor as HLOCAL);
			return Err(last_error("initializing ACL"));
		}

		if AddAccessAllowedAce(acl, ACL_REVISION, GENERIC_READ | GENERIC_WRITE, sid_copy) == FALSE {
			LocalFree(acl as HLOCAL);
			LocalFree(sid_copy as HLOCAL);
			LocalFree(descriptor as HLOCAL);
			return Err(last_error("adding allowed ACE"));
		}

		LocalFree(sid_copy as HLOCAL);

		if SetSecurityDescriptorDacl(descriptor, TRUE, acl, FALSE) == FALSE {
			LocalFree(acl as HLOCAL);
			LocalFree(descriptor as HLOCAL);
			return Err(last_error("setting DACL"));
		}

		let attributes = SECURITY_ATTRIBUTES {
			nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
			lpSecurityDescriptor: descriptor,
			bInheritHandle: FALSE,
		};

		Ok(SecurityAttributes {
			attributes,
			descriptor,
			acl,
		})
	}
}

fn duplicate_client_handle(handle: HANDLE) -> Result<HANDLE, ListenerError> {
	// SAFETY: GetCurrentProcess returns the documented pseudo-handle and has no
	// memory preconditions.
	let process = unsafe { GetCurrentProcess() };
	let mut duplicate: HANDLE = ptr::null_mut();
	// SAFETY: `duplicate` is a valid out pointer and `handle` is live for this call.
	let ok = unsafe { DuplicateHandle(process, handle, process, &mut duplicate, 0, FALSE, 2) };
	if ok == FALSE {
		return Err(last_error("duplicating pipe handle"));
	}
	Ok(duplicate)
}

fn duplicate_handle(handle: HANDLE) -> Result<HANDLE, ListenerError> {
	// SAFETY: GetCurrentProcess returns the documented pseudo-handle and has no
	// memory preconditions.
	let process = unsafe { GetCurrentProcess() };
	let mut duplicate: HANDLE = ptr::null_mut();
	// DUPLICATE_SAME_ACCESS = 2
	// SAFETY: `duplicate` is a valid out pointer and `handle` is live for this call.
	let ok = unsafe { DuplicateHandle(process, handle, process, &mut duplicate, 0, FALSE, 2) };
	if ok == FALSE {
		return Err(last_error("duplicating pipe handle"));
	}
	Ok(duplicate)
}
