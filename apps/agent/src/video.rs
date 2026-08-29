//! BGRA -> I420 conversion and H.264 encoding.
//!
//! `openh264`'s encoder wants frames as a type implementing its `YUVSource`
//! trait (three planes plus their strides) rather than a specific buffer
//! type, so `I420Frame` below implements that trait directly instead of
//! depending on the crate's own `YUVBuffer` helper. That trait is the
//! encoder's actual public input contract and is the least likely part of
//! this dependency to change between versions; if `cargo build` reports a
//! mismatch here, the trait's method list (in `openh264::formats::YUVSource`)
//! is the first place to check.
//!
//! Everything downstream of `encode_bgra` - the produced bytes - is Annex-B
//! H.264 (start-code-delimited NAL units), which is exactly what
//! `webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample`
//! expects to be handed per frame; it does the RTP packetization (RFC 6184)
//! internally.

use crate::capture::RawFrame;
use anyhow::{Context, Result};
use openh264::encoder::{Encoder, EncoderConfig};
use openh264::formats::YUVSource;

struct I420Frame {
    width: i32,
    height: i32,
    y: Vec<u8>,
    u: Vec<u8>,
    v: Vec<u8>,
}

impl YUVSource for I420Frame {
    fn width(&self) -> i32 {
        self.width
    }
    fn height(&self) -> i32 {
        self.height
    }
    fn y(&self) -> &[u8] {
        &self.y
    }
    fn u(&self) -> &[u8] {
        &self.u
    }
    fn v(&self) -> &[u8] {
        &self.v
    }
    fn y_stride(&self) -> i32 {
        self.width
    }
    fn u_stride(&self) -> i32 {
        self.width / 2
    }
    fn v_stride(&self) -> i32 {
        self.width / 2
    }
}

/// BT.601 full-range BGRA -> I420. Screen content is rendered in sRGB/BT.601
/// space by the desktop compositor, so this (rather than BT.709, which is
/// more common for camera video) is the correct matrix here.
fn bgra_to_i420(bgra: &[u8], width: u32, height: u32) -> I420Frame {
    let w = width as usize;
    let h = height as usize;
    let mut y_plane = vec![0u8; w * h];
    let mut u_plane = vec![0u8; (w / 2) * (h / 2)];
    let mut v_plane = vec![0u8; (w / 2) * (h / 2)];

    for row in 0..h {
        for col in 0..w {
            let i = (row * w + col) * 4;
            let b = bgra[i] as f32;
            let g = bgra[i + 1] as f32;
            let r = bgra[i + 2] as f32;

            let y = 0.299 * r + 0.587 * g + 0.114 * b;
            y_plane[row * w + col] = y.round().clamp(0.0, 255.0) as u8;

            // Chroma is subsampled 2x2: only compute it once per 2x2 block,
            // from that block's top-left sample.
            if row % 2 == 0 && col % 2 == 0 {
                let u = -0.169 * r - 0.331 * g + 0.5 * b + 128.0;
                let v = 0.5 * r - 0.419 * g - 0.081 * b + 128.0;
                let ci = (row / 2) * (w / 2) + (col / 2);
                u_plane[ci] = u.round().clamp(0.0, 255.0) as u8;
                v_plane[ci] = v.round().clamp(0.0, 255.0) as u8;
            }
        }
    }

    I420Frame { width: width as i32, height: height as i32, y: y_plane, u: u_plane, v: v_plane }
}

pub struct H264Encoder {
    encoder: Encoder,
    width: u32,
    height: u32,
}

impl H264Encoder {
    pub fn new(width: u32, height: u32) -> Result<Self> {
        // Odd dimensions break 2x2 chroma subsampling; DXGI output modes are
        // effectively always even, but this guards the invariant explicitly
        // rather than producing a subtly corrupt encode if that ever changes.
        anyhow::ensure!(width % 2 == 0 && height % 2 == 0, "capture dimensions must be even for I420");

        let config = EncoderConfig::new(width, height);
        let encoder = Encoder::with_config(config).context("initializing OpenH264 encoder")?;
        Ok(Self { encoder, width, height })
    }

    /// Encodes one frame, returning Annex-B bytes. Resolution must match what
    /// this encoder was constructed with - the caller (session.rs) recreates
    /// the encoder if the capture size changes (e.g. the remote display's
    /// resolution changed).
    pub fn encode_bgra(&mut self, frame: &RawFrame) -> Result<Vec<u8>> {
        anyhow::ensure!(
            frame.width == self.width && frame.height == self.height,
            "frame size {}x{} does not match encoder size {}x{}",
            frame.width,
            frame.height,
            self.width,
            self.height
        );

        let yuv = bgra_to_i420(&frame.bgra, frame.width, frame.height);
        let bitstream = self.encoder.encode(&yuv).context("H264 encode failed")?;
        Ok(bitstream.to_vec())
    }
}
