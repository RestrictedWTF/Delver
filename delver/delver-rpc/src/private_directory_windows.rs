//! Windows current-user-only directory creation and ACL auditing.
//!
//! Like the named-pipe listener this module exists because Win32 security is
//! the only way to restrict an object to the current user's SID, and no crate
//! in the dependency tree wraps it safely. It follows the same terms ADR 0003
//! set for `listener_windows`: the crate-level `deny(unsafe_code)` is lifted
//! only here, every call is an FFI call whose preconditions are argued at the
//! call site, and no unsafe code touches bytes read off a transport.

#![allow(unsafe_code)]

use super::PrivateDirectoryError;
use std::ffi::c_void;
use std::mem;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::ptr;
use windows_sys::Win32::Foundation::{
	CloseHandle, LocalFree, ERROR_ALREADY_EXISTS, ERROR_SUCCESS, FALSE, HANDLE, HLOCAL,
	INVALID_HANDLE_VALUE, TRUE,
};
use windows_sys::Win32::Security::Authorization::{GetSecurityInfo, SE_FILE_OBJECT};
use windows_sys::Win32::Security::{
	AclSizeInformation, AddAccessAllowedAceEx, CopySid, EqualSid, GetAce, GetAclInformation,
	GetLengthSid, GetSecurityDescriptorControl, GetTokenInformation, InitializeAcl,
	InitializeSecurityDescriptor, IsValidAcl, IsValidSid, SetSecurityDescriptorControl,
	SetSecurityDescriptorDacl, SetSecurityDescriptorOwner, TokenUser, ACCESS_ALLOWED_ACE, ACL,
	ACL_REVISION, ACL_SIZE_INFORMATION, CONTAINER_INHERIT_ACE, DACL_SECURITY_INFORMATION,
	OBJECT_INHERIT_ACE, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID,
	SECURITY_ATTRIBUTES, SE_DACL_PROTECTED, TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::Storage::FileSystem::{
	CreateDirectoryW, CreateFileW, GetFileAttributesW, GetFileInformationByHandle,
	BY_HANDLE_FILE_INFORMATION, FILE_ALL_ACCESS, FILE_ATTRIBUTE_DIRECTORY,
	FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
	FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, INVALID_FILE_ATTRIBUTES, OPEN_EXISTING,
	READ_CONTROL,
};
use windows_sys::Win32::System::Memory::{LocalAlloc, LPTR};
use windows_sys::Win32::System::SystemServices::{
	ACCESS_ALLOWED_ACE_TYPE, SECURITY_DESCRIPTOR_REVISION,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

pub(super) fn ensure(chain: &[PathBuf]) -> Result<(), PrivateDirectoryError> {
	let user_sid = current_user_sid()?;
	for directory in chain {
		let wide = wide_path(directory);
		// SAFETY: `wide` outlives the call and `wide_path` NUL-terminates it.
		let attributes = unsafe { GetFileAttributesW(wide.as_ptr()) };
		if attributes == INVALID_FILE_ATTRIBUTES {
			let security = create_directory_security(user_sid.as_sid())?;
			// SAFETY: both pointers are to live locals that outlive the call, and
			// `security` owns the descriptor and ACL its attributes point at.
			let created =
				unsafe { CreateDirectoryW(wide.as_ptr(), ptr::addr_of!(security.attributes)) };
			if created == FALSE {
				let error = std::io::Error::last_os_error();
				if error.raw_os_error() != Some(ERROR_ALREADY_EXISTS as i32) {
					return Err(PrivateDirectoryError::io(
						error,
						"creating private directory",
					));
				}
			}
		}
		audit_directory(&wide, user_sid.as_sid())?;
	}
	Ok(())
}

fn audit_directory(path: &[u16], user_sid: PSID) -> Result<(), PrivateDirectoryError> {
	// SAFETY: `path` is a NUL-terminated wide string that outlives the call and
	// the optional-pointer arguments are passed as null.
	let handle = unsafe {
		CreateFileW(
			path.as_ptr(),
			READ_CONTROL,
			FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
			ptr::null(),
			OPEN_EXISTING,
			FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
			ptr::null_mut(),
		)
	};
	if handle == INVALID_HANDLE_VALUE {
		return Err(last_error("opening private directory for audit"));
	}
	let handle = OwnedHandle(handle);
	let mut file_information = BY_HANDLE_FILE_INFORMATION::default();
	// SAFETY: `handle` is open for the call and the output struct is a live local
	// of exactly the type the API writes.
	if unsafe { GetFileInformationByHandle(handle.0, &mut file_information) } == FALSE {
		return Err(last_error("reading private directory attributes"));
	}
	if file_information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
		|| file_information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
	{
		return Err(PrivateDirectoryError::new(
			"private directory must be a real directory without a reparse point",
		));
	}

	let mut owner: PSID = ptr::null_mut();
	let mut dacl: *mut ACL = ptr::null_mut();
	let mut descriptor: PSECURITY_DESCRIPTOR = ptr::null_mut();
	// SAFETY: `handle` is open, each out-pointer addresses a live local, and the
	// unrequested outputs are passed as null. On success the descriptor is a
	// `LocalAlloc` block, taken over by `LocalAllocation` immediately below.
	let status = unsafe {
		GetSecurityInfo(
			handle.0,
			SE_FILE_OBJECT,
			OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
			ptr::addr_of_mut!(owner),
			ptr::null_mut(),
			ptr::addr_of_mut!(dacl),
			ptr::null_mut(),
			ptr::addr_of_mut!(descriptor),
		)
	};
	let descriptor = LocalAllocation(descriptor as HLOCAL);
	if status != ERROR_SUCCESS {
		return Err(PrivateDirectoryError::new(format!(
			"querying private directory security failed with Windows error {}",
			status
		)));
	}
	// SAFETY: the null checks run first, and short-circuiting means the SID and
	// ACL pointers reach the API only once `GetSecurityInfo` has populated them;
	// they stay valid while `descriptor` owns the enclosing block.
	if owner.is_null()
		|| dacl.is_null()
		|| unsafe { IsValidSid(owner) } == FALSE
		|| unsafe { IsValidAcl(dacl) } == FALSE
		|| unsafe { EqualSid(owner, user_sid) } == FALSE
	{
		return Err(PrivateDirectoryError::new(
			"private directory owner does not match the current user",
		));
	}

	let mut control = 0_u16;
	let mut revision = 0_u32;
	// SAFETY: `descriptor` owns a descriptor the API validated, and both outputs
	// are live locals of the expected width.
	if unsafe { GetSecurityDescriptorControl(descriptor.0 as _, &mut control, &mut revision) }
		== FALSE
		|| control & SE_DACL_PROTECTED == 0
	{
		return Err(PrivateDirectoryError::new(
			"private directory DACL is not protected",
		));
	}

	let mut information = ACL_SIZE_INFORMATION::default();
	// SAFETY: `dacl` was validated by `IsValidAcl` above, and the output buffer is
	// a live `ACL_SIZE_INFORMATION` described by its own `size_of`.
	if unsafe {
		GetAclInformation(
			dacl,
			ptr::addr_of_mut!(information) as *mut c_void,
			mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
			AclSizeInformation,
		)
	} == FALSE
		|| information.AceCount != 1
	{
		return Err(PrivateDirectoryError::new(
			"private directory DACL must contain exactly one access rule",
		));
	}

	let mut ace_pointer: *mut c_void = ptr::null_mut();
	// SAFETY: `dacl` is a validated ACL with exactly one ACE, so index 0 exists,
	// and the out-pointer addresses a live local.
	if unsafe { GetAce(dacl, 0, ptr::addr_of_mut!(ace_pointer)) } == FALSE || ace_pointer.is_null()
	{
		return Err(last_error("reading private directory access rule"));
	}
	// SAFETY: `GetAce` succeeded and returned a non-null pointer into the ACL
	// `descriptor` still owns. The type is only assumed here; `AceType` is
	// checked below before any field beyond the common header is trusted.
	let ace = unsafe { &*(ace_pointer as *const ACCESS_ALLOWED_ACE) };
	let required_flags = OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE;
	let ace_sid = ptr::addr_of!(ace.SidStart) as PSID;
	if ace.Header.AceType != ACCESS_ALLOWED_ACE_TYPE as u8
		|| ace.Header.AceFlags as u32 != required_flags
		|| ace.Mask != FILE_ALL_ACCESS
		// SAFETY: reached only once the ACE is confirmed to be an access-allowed
		// ACE, so `SidStart` begins a SID inside the ACL that is still alive.
		|| unsafe { EqualSid(ace_sid, user_sid) } == FALSE
	{
		return Err(PrivateDirectoryError::new(
			"private directory DACL is not current-user-only full control",
		));
	}
	Ok(())
}

struct DirectorySecurity {
	attributes: SECURITY_ATTRIBUTES,
	_descriptor: LocalAllocation,
	_acl: LocalAllocation,
}

fn create_directory_security(user_sid: PSID) -> Result<DirectorySecurity, PrivateDirectoryError> {
	// SAFETY: every allocation is null-checked before use and is owned by a
	// `LocalAllocation` from the moment it is created, so no pointer outlives its
	// block. `user_sid` comes from `current_user_sid` and is checked by
	// `IsValidSid` before its length is read. The ACL is sized as the `ACL`
	// header, plus the fixed 8 bytes of an access-allowed ACE ahead of its
	// `SidStart` placeholder, plus the SID — exactly what
	// `AddAccessAllowedAceEx` writes into it. The returned
	// `DirectorySecurity` keeps the descriptor and ACL alive for as long as the
	// `SECURITY_ATTRIBUTES` that point at them.
	unsafe {
		let descriptor = LocalAllocation(LocalAlloc(LPTR, 256));
		if descriptor.0.is_null() {
			return Err(last_error(
				"allocating private directory security descriptor",
			));
		}
		if InitializeSecurityDescriptor(descriptor.0 as _, SECURITY_DESCRIPTOR_REVISION) == FALSE {
			return Err(last_error(
				"initializing private directory security descriptor",
			));
		}
		if SetSecurityDescriptorOwner(descriptor.0 as _, user_sid, FALSE) == FALSE {
			return Err(last_error("setting private directory owner"));
		}

		if IsValidSid(user_sid) == FALSE {
			return Err(PrivateDirectoryError::new(
				"the current user SID is invalid",
			));
		}
		let sid_length = GetLengthSid(user_sid);
		let acl_size = mem::size_of::<ACL>() as u32 + 8 + sid_length;
		let acl = LocalAllocation(LocalAlloc(LPTR, acl_size as usize));
		if acl.0.is_null() {
			return Err(last_error("allocating private directory ACL"));
		}
		if InitializeAcl(acl.0 as *mut ACL, acl_size, ACL_REVISION) == FALSE {
			return Err(last_error("initializing private directory ACL"));
		}
		if AddAccessAllowedAceEx(
			acl.0 as *mut ACL,
			ACL_REVISION,
			OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE,
			FILE_ALL_ACCESS,
			user_sid,
		) == FALSE
		{
			return Err(last_error("adding private directory access rule"));
		}
		if SetSecurityDescriptorDacl(descriptor.0 as _, TRUE, acl.0 as *const ACL, FALSE) == FALSE {
			return Err(last_error("setting private directory DACL"));
		}
		if SetSecurityDescriptorControl(descriptor.0 as _, SE_DACL_PROTECTED, SE_DACL_PROTECTED)
			== FALSE
		{
			return Err(last_error("protecting private directory DACL"));
		}

		let attributes = SECURITY_ATTRIBUTES {
			nLength: mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
			lpSecurityDescriptor: descriptor.0 as _,
			bInheritHandle: FALSE,
		};
		Ok(DirectorySecurity {
			attributes,
			_descriptor: descriptor,
			_acl: acl,
		})
	}
}

fn current_user_sid() -> Result<LocalAllocation, PrivateDirectoryError> {
	// SAFETY: the token handle and both allocations are owned by RAII wrappers
	// and null-checked before use. `GetTokenInformation` is called first with a
	// null buffer purely to learn the required size, and the `TOKEN_USER` cast is
	// only performed on a buffer the same call then filled with `TokenUser` data.
	// The SID is copied out with `CopySid` so the result does not borrow from the
	// token buffer, which is freed on return.
	unsafe {
		let mut token: HANDLE = ptr::null_mut();
		if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == FALSE {
			return Err(last_error("opening current process token"));
		}
		let token = OwnedHandle(token);
		let mut size = 0_u32;
		let _ = GetTokenInformation(token.0, TokenUser, ptr::null_mut(), 0, &mut size);
		if size == 0 {
			return Err(last_error("querying current user SID size"));
		}
		let token_user = LocalAllocation(LocalAlloc(LPTR, size as usize));
		if token_user.0.is_null() {
			return Err(last_error("allocating current user token information"));
		}
		if GetTokenInformation(token.0, TokenUser, token_user.0, size, &mut size) == FALSE {
			return Err(last_error("querying current user token information"));
		}
		let sid_source = (*(token_user.0 as *const TOKEN_USER)).User.Sid;
		let sid_length = GetLengthSid(sid_source);
		let sid = LocalAllocation(LocalAlloc(LPTR, sid_length as usize));
		if sid.0.is_null() || CopySid(sid_length, sid.0, sid_source) == FALSE {
			return Err(last_error("copying current user SID"));
		}
		Ok(sid)
	}
}

fn wide_path(path: &Path) -> Vec<u16> {
	path.as_os_str().encode_wide().chain(Some(0)).collect()
}

fn last_error(context: &str) -> PrivateDirectoryError {
	PrivateDirectoryError::io(std::io::Error::last_os_error(), context)
}

struct LocalAllocation(HLOCAL);

impl LocalAllocation {
	fn as_sid(&self) -> PSID {
		self.0
	}
}

impl Drop for LocalAllocation {
	fn drop(&mut self) {
		if !self.0.is_null() {
			// SAFETY: the pointer came from `LocalAlloc` or a Win32 call
			// documented to return `LocalFree`-able memory, is non-null, and is
			// freed exactly once because `LocalAllocation` owns it.
			unsafe {
				LocalFree(self.0);
			}
		}
	}
}

struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
	fn drop(&mut self) {
		if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
			// SAFETY: the handle came from a successful Win32 open, is owned
			// solely by this wrapper, and is closed exactly once.
			unsafe {
				CloseHandle(self.0);
			}
		}
	}
}
