# Dot-source this to get a working MSVC + rustup cargo environment in the
# current PowerShell session. Needed because this sandbox has a full Rust
# toolchain and MSVC Build Tools installed, but neither is on PATH by
# default, and rustup's cargo/rustc shims were never created in .cargo\bin
# (only rustup.exe is there) - so both the toolchain bin and MSVC's vcvars
# have to be imported by hand, every session, since env vars don't persist
# between separate tool invocations.

$vsPath = "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools"
$vcvars = Join-Path $vsPath "VC\Auxiliary\Build\vcvars64.bat"
$envDump = cmd /c "`"$vcvars`" && set" 2>&1
foreach ($line in $envDump) {
    if ($line -match "^(INCLUDE|LIB|LIBPATH|PATH)=(.*)$") {
        Set-Item -Path "Env:\$($matches[1])" -Value $matches[2]
    }
}

$toolchainBin = "C:\Users\anmol\.rustup\toolchains\stable-x86_64-pc-windows-msvc\bin"
$env:PATH = "$toolchainBin;C:\Users\anmol\.cargo\bin;$env:PATH"
$env:CARGO_HOME = "C:\Users\anmol\.cargo"
$env:RUSTUP_HOME = "C:\Users\anmol\.rustup"
