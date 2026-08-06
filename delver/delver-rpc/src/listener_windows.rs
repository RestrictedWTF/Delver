//! Windows named-pipe listener implementation.
//!
//! Each pipe instance is created with a DACL that allows access only to the
//! user that created it. The unsafe code in this module is confined to Win32
//! security and pipe APIs; it does not parse or interpret RPC payloads.

#![allow(unsafe_code)]

use std::ffi::c_void;
use std::fs::File;
use std::io::{Read, Write};
use std::os::windows::io::FromRawHandle;
use std::ptr;

use windows_sys::Win32::Foundation::{CloseHandle, DuplicateHandle, FALSE, HANDLE, HLOCAL, LocalFree, TRUE};
use windows_sys::Win32::Security::{
    ACL, ACL_REVISION, AddAccessAllowedAce, CopySid, GetLengthSid, GetTokenInformation,
    InitializeAcl, InitializeSecurityDescriptor, PSECURITY_DESCRIPTOR, PSID,
    SetSecurityDescriptorDacl, TOKEN_QUERY, TOKEN_USER, TokenUser, SECURITY_ATTRIBUTES,
};
use windows_sys::Win32::System::SystemServices::SECURITY_DESCRIPTOR_REVISION;
use windows_sys::Win32::Storage::FileSystem::{
    FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES,
    PIPE_WAIT,
};
use windows_sys::Win32::System::Memory::{LocalAlloc, LPTR};
use windows_sys::Win32::System::Pipes::{ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

use crate::listener::{Endpoint, ListenerError, last_error};

const PIPE_BUFFER_SIZE: u32 = 65536;
const GENERIC_READ: u32 = 0x80000000;
const GENERIC_WRITE: u32 = 0x40000000;

pub(crate) struct WindowsListenerImpl {
    /// The Win32 path of the named pipe, e.g. `\\.\pipe\delver-...`.
    pipe_path: String,
}

impl WindowsListenerImpl {
    pub(crate) fn bind(endpoint: &Endpoint) -> Result<Self, ListenerError> {
        let Endpoint::NamedPipe(pipe_path) = endpoint else {
            return Err(ListenerError::new("only pipe:// or npipe:// endpoints are supported on Windows"));
        };

        // Create the first instance so the pipe namespace exists. ACL is set
        // on the kernel object at creation time.
        let handle = create_pipe_instance(pipe_path, FILE_FLAG_FIRST_PIPE_INSTANCE)?;
        // Close the bootstrap instance; subsequent accepts create fresh ones.
        unsafe {
            CloseHandle(handle);
        }

        Ok(Self {
            pipe_path: pipe_path.clone(),
        })
    }

    pub(crate) fn accept(&self) -> Result<(Box<dyn Read + Send>, Box<dyn Write + Send>), ListenerError> {
        let handle = create_pipe_instance(&self.pipe_path, 0)?;

        let connected = unsafe { ConnectNamedPipe(handle, ptr::null_mut()) };
        if connected == FALSE {
            let err = std::io::Error::last_os_error();
            // ERROR_PIPE_CONNECTED (535) means the client connected before we
            // called ConnectNamedPipe; that is still a success.
            if err.raw_os_error() != Some(535) {
                unsafe {
                    DisconnectNamedPipe(handle);
                    CloseHandle(handle);
                }
                return Err(ListenerError::io(err, "waiting for pipe connection"));
            }
        }

        // Split the handle into independent read and write halves so the
        // framed transport can own them separately.
        let read_handle = duplicate_handle(handle)?;
        let write_handle = duplicate_handle(handle)?;

        unsafe {
            CloseHandle(handle);
        }

        let read_file = unsafe { File::from_raw_handle(read_handle) };
        let write_file = unsafe { File::from_raw_handle(write_handle) };

        Ok((Box::new(read_file), Box::new(write_file)))
    }
}

fn create_pipe_instance(path: &str, extra_flags: u32) -> Result<HANDLE, ListenerError> {
    let name_wide: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();

    let mut security = create_user_only_security_attributes()?;

    let handle = unsafe {
        CreateNamedPipeW(
            name_wide.as_ptr(),
            PIPE_ACCESS_DUPLEX | extra_flags,
            PIPE_TYPE_BYTE | PIPE_WAIT,
            PIPE_UNLIMITED_INSTANCES,
            PIPE_BUFFER_SIZE,
            PIPE_BUFFER_SIZE,
            0,
            ptr::addr_of!(security.attributes),
        )
    };

    // The security descriptor was allocated on the heap; free it now that the
    // kernel has copied it.
    unsafe {
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
}

fn create_user_only_security_attributes() -> Result<SecurityAttributes, ListenerError> {
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
        let acl_size = std::mem::size_of::<ACL>() as u32
            + std::mem::size_of::<u32>() as u32 // ACE header + mask
            + sid_len as u32;
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
        })
    }
}

fn duplicate_handle(handle: HANDLE) -> Result<HANDLE, ListenerError> {
    let process = unsafe { GetCurrentProcess() };
    let mut duplicate: HANDLE = ptr::null_mut();
    // DUPLICATE_SAME_ACCESS = 2
    let ok = unsafe {
        DuplicateHandle(
            process,
            handle,
            process,
            &mut duplicate,
            0,
            FALSE,
            2,
        )
    };
    if ok == FALSE {
        return Err(last_error("duplicating pipe handle"));
    }
    Ok(duplicate)
}
