#[cfg(windows)]
mod windows {
    use std::{
        ffi::{OsStr, OsString},
        fs::{File, OpenOptions},
        io,
        mem::{size_of, zeroed},
        os::windows::{
            ffi::OsStrExt,
            io::{AsRawHandle, FromRawHandle, OwnedHandle},
        },
        path::{Path, PathBuf},
        ptr::{null, null_mut},
        thread,
        time::{Duration, Instant},
    };
    use windows_sys::Win32::{
        Foundation::{
            SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT, WAIT_FAILED, WAIT_OBJECT_0,
            WAIT_TIMEOUT,
        },
        System::{
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
                JobObjectExtendedLimitInformation, QueryInformationJobObject,
                SetInformationJobObject, TerminateJobObject,
                JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
            Threading::{
                CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess,
                InitializeProcThreadAttributeList, ResumeThread, TerminateProcess,
                UpdateProcThreadAttribute, WaitForSingleObject, CREATE_NO_WINDOW, CREATE_SUSPENDED,
                EXTENDED_STARTUPINFO_PRESENT, LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST, STARTF_USESTDHANDLES, STARTUPINFOEXW,
            },
        },
    };

    fn wide(value: &OsStr) -> Vec<u16> {
        value.encode_wide().chain(Some(0)).collect()
    }

    fn quote_argument(value: &OsStr) -> Vec<u16> {
        let mut result = vec![b'"' as u16];
        let mut slashes = 0;
        for ch in value.encode_wide() {
            if ch == b'\\' as u16 {
                slashes += 1;
            } else {
                let count = if ch == b'"' as u16 {
                    slashes * 2 + 1
                } else {
                    slashes
                };
                result.extend(std::iter::repeat_n(b'\\' as u16, count));
                result.push(ch);
                slashes = 0;
            }
        }
        result.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2));
        result.push(b'"' as u16);
        result
    }

    struct InheritedHandles {
        _storage: Vec<usize>,
        pointer: LPPROC_THREAD_ATTRIBUTE_LIST,
    }

    impl InheritedHandles {
        fn new(handles: &[HANDLE]) -> io::Result<Self> {
            unsafe {
                let mut bytes = 0;
                InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut bytes);
                let mut storage = vec![0usize; bytes.div_ceil(size_of::<usize>())];
                let pointer = storage.as_mut_ptr().cast();
                if InitializeProcThreadAttributeList(pointer, 1, 0, &mut bytes) == 0 {
                    return Err(io::Error::last_os_error());
                }
                let list = Self {
                    _storage: storage,
                    pointer,
                };
                if UpdateProcThreadAttribute(
                    list.pointer,
                    0,
                    PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                    handles.as_ptr().cast(),
                    std::mem::size_of_val(handles),
                    null_mut(),
                    null(),
                ) == 0
                {
                    return Err(io::Error::last_os_error());
                }
                Ok(list)
            }
        }
    }

    impl Drop for InheritedHandles {
        fn drop(&mut self) {
            unsafe {
                DeleteProcThreadAttributeList(self.pointer);
            }
        }
    }

    pub struct OwnedProcess {
        // Closing the job terminates the launcher and all descendants, including after a crash.
        job: OwnedHandle,
        process: OwnedHandle,
        status_file: PathBuf,
    }

    impl OwnedProcess {
        pub fn spawn(
            node: &Path,
            launcher: &Path,
            data_dir: &Path,
            status_file: &Path,
        ) -> io::Result<Self> {
            // Tauri canonicalizes resources to \\?\ paths, which Node's entry resolver cannot read.
            let node = dunce::simplified(node);
            let launcher = dunce::simplified(launcher);
            let data_dir = dunce::simplified(data_dir);
            let status_file = dunce::simplified(status_file);
            let arguments: [OsString; 6] = [
                node.as_os_str().into(),
                launcher.as_os_str().into(),
                "--data-dir".into(),
                data_dir.as_os_str().into(),
                "--status-file".into(),
                status_file.as_os_str().into(),
            ];
            let mut command_line = Vec::new();
            for argument in arguments {
                if !command_line.is_empty() {
                    command_line.push(b' ' as u16);
                }
                command_line.extend(quote_argument(&argument));
            }
            command_line.push(0);
            let executable = wide(node.as_os_str());
            let cwd = wide(data_dir.as_os_str());
            std::fs::create_dir_all(data_dir.join("logs"))?;
            let output = OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .open(data_dir.join("logs/bootstrap.log"))?;
            let input = File::open("NUL")?;

            unsafe {
                let handles = [
                    input.as_raw_handle() as HANDLE,
                    output.as_raw_handle() as HANDLE,
                ];
                for handle in handles {
                    if SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) == 0 {
                        return Err(io::Error::last_os_error());
                    }
                }
                // Inherit only these valid standard handles; never leak the job or native app handles.
                let inherited = InheritedHandles::new(&handles)?;
                let job_handle = CreateJobObjectW(null(), null());
                if job_handle.is_null() {
                    return Err(io::Error::last_os_error());
                }
                let job = OwnedHandle::from_raw_handle(job_handle);
                let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if SetInformationJobObject(
                    job_handle,
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                ) == 0
                {
                    return Err(io::Error::last_os_error());
                }

                let mut startup: STARTUPINFOEXW = zeroed();
                startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
                startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
                startup.StartupInfo.hStdInput = handles[0];
                startup.StartupInfo.hStdOutput = handles[1];
                startup.StartupInfo.hStdError = handles[1];
                startup.lpAttributeList = inherited.pointer;
                let mut info: PROCESS_INFORMATION = zeroed();
                if CreateProcessW(
                    executable.as_ptr(),
                    command_line.as_mut_ptr(),
                    null(),
                    null(),
                    1,
                    CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT,
                    null(),
                    cwd.as_ptr(),
                    &startup.StartupInfo,
                    &mut info,
                ) == 0
                {
                    return Err(io::Error::last_os_error());
                }
                let process = OwnedHandle::from_raw_handle(info.hProcess);
                let thread = OwnedHandle::from_raw_handle(info.hThread);

                // The suspended launcher cannot create unowned children before assignment succeeds.
                if AssignProcessToJobObject(job_handle, info.hProcess) == 0 {
                    let error = io::Error::last_os_error();
                    TerminateProcess(info.hProcess, 1);
                    return Err(error);
                }
                if ResumeThread(thread.as_raw_handle() as HANDLE) == u32::MAX {
                    return Err(io::Error::last_os_error());
                }
                Ok(Self {
                    job,
                    process,
                    status_file: status_file.to_path_buf(),
                })
            }
        }

        pub fn exit_code(&self) -> io::Result<Option<u32>> {
            unsafe {
                let handle = self.process.as_raw_handle() as HANDLE;
                match WaitForSingleObject(handle, 0) {
                    WAIT_OBJECT_0 => {}
                    WAIT_TIMEOUT => return Ok(None),
                    WAIT_FAILED => return Err(io::Error::last_os_error()),
                    _ => return Err(io::Error::other("Unexpected process wait result")),
                }
                let mut code = 0;
                if GetExitCodeProcess(handle, &mut code) == 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(Some(code))
            }
        }
    }

    impl Drop for OwnedProcess {
        fn drop(&mut self) {
            unsafe {
                let shutdown_file = self.status_file.with_extension("json.shutdown");
                if WaitForSingleObject(self.process.as_raw_handle() as HANDLE, 0) == WAIT_TIMEOUT {
                    if std::fs::write(&shutdown_file, []).is_ok() {
                        WaitForSingleObject(self.process.as_raw_handle() as HANDLE, 8_000);
                    }
                }
                let job = self.job.as_raw_handle() as HANDLE;
                TerminateJobObject(job, 1);
                // Wait for every owned child to release its sockets before a retry binds the same port.
                let started = Instant::now();
                while started.elapsed() < Duration::from_secs(5) {
                    let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = zeroed();
                    if QueryInformationJobObject(
                        job,
                        JobObjectBasicAccountingInformation,
                        (&mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                        size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                        null_mut(),
                    ) == 0
                        || accounting.ActiveProcesses == 0
                    {
                        break;
                    }
                    thread::sleep(Duration::from_millis(20));
                }
                let _ = std::fs::remove_file(shutdown_file);
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn windows_arguments_preserve_spaces_quotes_and_trailing_slashes() {
            let quote =
                |value: &str| String::from_utf16(&quote_argument(OsStr::new(value))).unwrap();
            assert_eq!(
                quote("C:\\Program Files\\node.exe"),
                "\"C:\\Program Files\\node.exe\""
            );
            assert_eq!(quote("C:\\data\\"), "\"C:\\data\\\\\"");
            assert_eq!(quote("a\"b"), "\"a\\\"b\"");
            assert_eq!(quote(""), "\"\"");
        }

        #[test]
        fn native_node_launch_has_valid_stdio_and_captures_bootstrap_errors() {
            let node = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../runtime/node.exe");
            assert!(
                node.is_file(),
                "Run desktop:prepare before native Rust tests"
            );
            let timestamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let directory = std::env::temp_dir().join(format!(
                "oh-story-native-node-{}-{timestamp}",
                std::process::id()
            ));
            std::fs::create_dir_all(&directory).unwrap();
            let launcher = directory.join("launcher test.mjs");
            std::fs::write(&launcher, "import { writeFileSync } from 'node:fs';\nprocess.stdin.read(0);\nprocess.stdout.write('stdout-ok\\n');\nprocess.stderr.write('stderr-ok\\n');\nwriteFileSync(process.argv[5], 'child-started');\n").unwrap();
            let status_file = directory.join("status.json");
            let process = OwnedProcess::spawn(&node, &launcher, &directory, &status_file).unwrap();
            let started = Instant::now();
            let code = loop {
                if let Some(code) = process.exit_code().unwrap() {
                    break code;
                }
                assert!(
                    started.elapsed() < Duration::from_secs(10),
                    "Node launch did not finish"
                );
                thread::sleep(Duration::from_millis(20));
            };
            drop(process);
            let output = std::fs::read_to_string(directory.join("logs/bootstrap.log")).unwrap();
            assert_eq!(code, 0, "{output}");
            assert_eq!(
                std::fs::read_to_string(&status_file).unwrap(),
                "child-started"
            );
            assert!(output.contains("stdout-ok"));
            assert!(output.contains("stderr-ok"));
            std::fs::remove_dir_all(directory).unwrap();
        }

        #[test]
        fn canonicalized_runtime_resources_start_dsh_with_separate_data_directory() {
            let runtime = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../runtime")
                .canonicalize()
                .unwrap();
            let timestamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let directory = std::env::temp_dir().join(format!(
                "oh-story-native-dsh-{}-{timestamp}",
                std::process::id()
            ));
            std::fs::create_dir_all(&directory).unwrap();
            let directory = directory.canonicalize().unwrap();
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            drop(listener);
            std::fs::write(
                directory.join("desktop.json"),
                format!(r#"{{"schemaVersion":1,"port":{port}}}"#),
            )
            .unwrap();
            let status_file = directory.join("status.json");
            let process = OwnedProcess::spawn(
                &runtime.join("node.exe"),
                &runtime.join("launcher.mjs"),
                &directory,
                &status_file,
            )
            .unwrap();
            let started = Instant::now();
            loop {
                if let Ok(data) = std::fs::read(&status_file) {
                    if let Ok(status) = serde_json::from_slice::<serde_json::Value>(&data) {
                        match status["state"].as_str() {
                            Some("ready") => break,
                            Some("error") => panic!(
                                "DSH startup failed: {}",
                                status["message"].as_str().unwrap_or("unknown error")
                            ),
                            _ => {}
                        }
                    }
                }
                let output = || {
                    std::fs::read_to_string(directory.join("logs/bootstrap.log"))
                        .unwrap_or_default()
                };
                assert!(
                    process.exit_code().unwrap().is_none(),
                    "DSH launcher exited: {}",
                    output()
                );
                assert!(
                    started.elapsed() < Duration::from_secs(45),
                    "DSH startup timed out: {}",
                    output()
                );
                thread::sleep(Duration::from_millis(100));
            }
            drop(process);
            assert!(std::net::TcpStream::connect_timeout(
                &format!("127.0.0.1:{port}").parse().unwrap(),
                Duration::from_millis(200)
            )
            .is_err());
            std::fs::remove_dir_all(directory).unwrap();
        }
    }
}

#[cfg(windows)]
pub use windows::OwnedProcess;

#[cfg(not(windows))]
pub struct OwnedProcess;

#[cfg(not(windows))]
impl OwnedProcess {
    pub fn spawn(
        _: &std::path::Path,
        _: &std::path::Path,
        _: &std::path::Path,
        _: &std::path::Path,
    ) -> std::io::Result<Self> {
        Err(std::io::Error::other(
            "This desktop runtime currently supports Windows only",
        ))
    }

    pub fn exit_code(&self) -> std::io::Result<Option<u32>> {
        Ok(Some(1))
    }
}
