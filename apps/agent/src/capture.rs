//! Screen capture via DXGI Desktop Duplication.
//!
//! This is the standard, GPU-accelerated way to grab frames on Windows 8+:
//! the OS composits into a shared texture and hands the caller only the
//! regions that changed, rather than the caller polling and diffing pixels
//! itself. It captures the primary display's output 0 only - multi-monitor
//! selection is future work (see the module doc in `input.rs`).
//!
//! Known limitations inherent to this API, not this implementation:
//!   - Cannot capture the secure desktop (UAC consent prompts, the lock
//!     screen, Ctrl+Alt+Del screen) unless the caller runs as a Windows
//!     service in Session 0 with the right access - the same boundary that
//!     makes `sas.rs`'s Ctrl+Alt+Del delicate to deploy.
//!   - Cannot capture DRM-protected video content (by design).
//!   - `AcquireNextFrame` returns `DXGI_ERROR_ACCESS_LOST` after things like a
//!     resolution change, a GPU driver reset, or a session lock/unlock; the
//!     duplication interface must be recreated, which `next_frame` does
//!     automatically rather than surfacing the error to the caller.

use anyhow::{Context, Result};
use windows::Win32::Foundation::{HANDLE, HMODULE};
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
    D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_FLAG, D3D11_MAP_READ, D3D11_RESOURCE_MISC_FLAG,
    D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::{
    IDXGIDevice, IDXGIOutput1, IDXGIOutputDuplication, DXGI_ERROR_ACCESS_LOST,
    DXGI_ERROR_WAIT_TIMEOUT, DXGI_OUTDUPL_FRAME_INFO,
};
use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM;

pub struct RawFrame {
    pub width: u32,
    pub height: u32,
    /// Tightly packed BGRA8, `width * 4` bytes per row - the DXGI staging
    /// texture's row pitch is stripped out here so downstream code (the YUV
    /// converter in video.rs) never has to know about GPU row alignment.
    pub bgra: Vec<u8>,
}

pub struct ScreenCapture {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    output: IDXGIOutput1,
    duplication: IDXGIOutputDuplication,
    width: u32,
    height: u32,
}

impl ScreenCapture {
    pub fn new() -> Result<Self> {
        let (device, context) = create_d3d11_device()?;
        let output = primary_output(&device)?;
        let (duplication, width, height) = duplicate_output(&device, &output)?;

        Ok(Self { device, context, output, duplication, width, height })
    }

    pub fn dimensions(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    /// Blocks up to `timeout_ms` for a new frame. Returns `Ok(None)` on a
    /// plain timeout (nothing changed on screen), which is the common case at
    /// a typical capture rate and is not an error.
    pub fn next_frame(&mut self, timeout_ms: u32) -> Result<Option<RawFrame>> {
        let mut frame_info = DXGI_OUTDUPL_FRAME_INFO::default();
        let mut resource = None;

        let acquire = unsafe {
            self.duplication
                .AcquireNextFrame(timeout_ms, &mut frame_info, &mut resource)
        };

        match acquire {
            Ok(()) => {}
            Err(err) if err.code() == DXGI_ERROR_WAIT_TIMEOUT => return Ok(None),
            Err(err) if err.code() == DXGI_ERROR_ACCESS_LOST => {
                tracing::warn!("DXGI duplication access lost, recreating (likely a mode/session change)");
                let (duplication, width, height) = duplicate_output(&self.device, &self.output)?;
                self.duplication = duplication;
                self.width = width;
                self.height = height;
                return Ok(None);
            }
            Err(err) => return Err(err).context("AcquireNextFrame failed"),
        }

        // AcquireNextFrame can succeed with zero accumulated frames if only
        // the cursor moved; there is nothing new to encode in that case.
        let result = if frame_info.LastPresentTime != 0 {
            let resource = resource.context("AcquireNextFrame succeeded without a resource")?;
            let frame = self.copy_frame(resource)?;
            Some(frame)
        } else {
            None
        };

        unsafe {
            let _ = self.duplication.ReleaseFrame();
        }

        Ok(result)
    }

    fn copy_frame(&self, resource: windows::core::IUnknown) -> Result<RawFrame> {
        let acquired: ID3D11Texture2D = resource.cast().context("acquired frame was not a Texture2D")?;

        let mut desc = D3D11_TEXTURE2D_DESC::default();
        unsafe { acquired.GetDesc(&mut desc) };

        let staging_desc = D3D11_TEXTURE2D_DESC {
            Usage: D3D11_USAGE_STAGING,
            BindFlags: Default::default(),
            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
            MiscFlags: D3D11_RESOURCE_MISC_FLAG(0),
            ..desc
        };

        let mut staging: Option<ID3D11Texture2D> = None;
        unsafe {
            self.device
                .CreateTexture2D(&staging_desc, None, Some(&mut staging))
                .context("creating CPU-readable staging texture")?;
        }
        let staging = staging.context("staging texture creation returned no texture")?;

        unsafe {
            self.context.CopyResource(&staging, &acquired);
        }

        let mut mapped = Default::default();
        unsafe {
            self.context
                .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
                .context("mapping staging texture for CPU read")?;
        }

        let width = desc.Width;
        let height = desc.Height;
        let row_pitch = mapped.RowPitch as usize;
        let mut bgra = vec![0u8; (width * height * 4) as usize];

        unsafe {
            let src = mapped.pData as *const u8;
            for row in 0..height as usize {
                let src_row = std::slice::from_raw_parts(src.add(row * row_pitch), width as usize * 4);
                let dst_start = row * width as usize * 4;
                bgra[dst_start..dst_start + width as usize * 4].copy_from_slice(src_row);
            }
            self.context.Unmap(&staging, 0);
        }

        debug_assert_eq!(desc.Format, DXGI_FORMAT_B8G8R8A8_UNORM, "unexpected DXGI surface format");

        Ok(RawFrame { width, height, bgra })
    }
}

fn create_d3d11_device() -> Result<(ID3D11Device, ID3D11DeviceContext)> {
    let mut device: Option<ID3D11Device> = None;
    let mut context: Option<ID3D11DeviceContext> = None;

    unsafe {
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_FLAG(0),
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )
        .context("D3D11CreateDevice failed - is a GPU driver installed?")?;
    }

    Ok((
        device.context("D3D11CreateDevice returned no device")?,
        context.context("D3D11CreateDevice returned no context")?,
    ))
}

fn primary_output(device: &ID3D11Device) -> Result<IDXGIOutput1> {
    let dxgi_device: IDXGIDevice = device.cast().context("casting D3D11 device to IDXGIDevice")?;
    let adapter = unsafe { dxgi_device.GetAdapter() }.context("getting DXGI adapter")?;
    let output = unsafe { adapter.EnumOutputs(0) }.context("enumerating output 0 (primary display)")?;
    output.cast().context("casting IDXGIOutput to IDXGIOutput1")
}

fn duplicate_output(device: &ID3D11Device, output: &IDXGIOutput1) -> Result<(IDXGIOutputDuplication, u32, u32)> {
    let duplication = unsafe { output.DuplicateOutput(device) }.context(
        "DuplicateOutput failed - another process may already hold an exclusive duplication, \
         or this session cannot access the desktop (e.g. running on the secure desktop)",
    )?;

    let mut desc = Default::default();
    unsafe { duplication.GetDesc(&mut desc) };

    Ok((duplication, desc.ModeDesc.Width, desc.ModeDesc.Height))
}

// SAFETY: ID3D11Device/Context/DXGI interfaces are used from a single capture
// thread throughout this agent (see session.rs), so Send is sound in practice
// even though the raw COM types are not Sync. This mirrors the pattern used
// by every windows-rs screen-capture example.
unsafe impl Send for ScreenCapture {}
