//! Camera capture via `nokhwa` (Media Foundation backend on Windows),
//! chosen over hand-written Media Foundation COM for the same reason
//! `arboard` and `openh264` were: a well-scoped wrapper for a well-understood
//! job rather than another large hand-rolled FFI surface.
//!
//! This only ever runs after `session.rs::grant_camera` has already gone
//! through the full consent handshake (owner permission + a live per-session
//! approval at this machine) - see that function's doc comment. Opening the
//! camera here goes through the same OS capture APIs any other application
//! would use, so the platform's own camera privacy indicator (the light next
//! to the lens, and Windows' camera-in-use icon) lights up exactly as it
//! would for a video call app. There is no path in this codebase that opens
//! a camera silently.
//!
//! Produces frames in the same shape `capture.rs` does (`RawFrame`, tightly
//! packed BGRA8) so `video.rs`'s existing H.264 encoding pipeline handles
//! camera video with no changes of its own.

use crate::capture::RawFrame;
use anyhow::{Context, Result};
use nokhwa::pixel_format::RgbFormat;
use nokhwa::utils::{CameraIndex, RequestedFormat, RequestedFormatType};
use nokhwa::Camera;

pub struct CameraCapture {
    camera: Camera,
}

impl CameraCapture {
    /// Opens the system's default camera (index 0) at its highest available
    /// frame rate for whatever resolution it negotiates. Device selection
    /// (letting the owner pick among multiple cameras) is a follow-up, not
    /// implemented in this phase - see `backend/agent/README.md`.
    pub fn new() -> Result<Self> {
        let requested = RequestedFormat::new::<RgbFormat>(RequestedFormatType::AbsoluteHighestFrameRate);
        let mut camera = Camera::new(CameraIndex::Index(0), requested)
            .context("opening the default camera - is one connected, and not already in exclusive use?")?;
        camera.open_stream().context("starting the camera stream")?;
        Ok(Self { camera })
    }

    pub fn dimensions(&self) -> (u32, u32) {
        let resolution = self.camera.resolution();
        (resolution.width(), resolution.height())
    }

    /// Blocks until the next frame is available and returns it as tightly
    /// packed BGRA8, matching `capture::RawFrame`.
    pub fn next_frame(&mut self) -> Result<RawFrame> {
        let frame = self.camera.frame().context("reading a camera frame")?;
        let rgb = frame.decode_image::<RgbFormat>().context("decoding camera frame to RGB")?;
        let (width, height) = (rgb.width(), rgb.height());

        let rgb_bytes = rgb.into_raw();
        let mut bgra = vec![0u8; rgb_bytes.len() / 3 * 4];
        for (src, dst) in rgb_bytes.chunks_exact(3).zip(bgra.chunks_exact_mut(4)) {
            dst[0] = src[2]; // B
            dst[1] = src[1]; // G
            dst[2] = src[0]; // R
            dst[3] = 255; // A
        }

        Ok(RawFrame { width, height, bgra })
    }
}

impl Drop for CameraCapture {
    fn drop(&mut self) {
        let _ = self.camera.stop_stream();
    }
}

// SAFETY: used from a single dedicated capture thread throughout this agent
// (see session.rs), matching the same justification as `ScreenCapture`.
unsafe impl Send for CameraCapture {}
