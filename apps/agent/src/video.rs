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
use openh264::OpenH264API;

struct I420Frame {
    width: usize,
    height: usize,
    y: Vec<u8>,
    u: Vec<u8>,
    v: Vec<u8>,
}

impl YUVSource for I420Frame {
    fn dimensions(&self) -> (usize, usize) {
        (self.width, self.height)
    }
    fn strides(&self) -> (usize, usize, usize) {
        (self.width, self.width / 2, self.width / 2)
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
}

/// BT.601 full-range BGRA -> I420. Screen content is rendered in sRGB/BT.601
/// space by the desktop compositor, so this (rather than BT.709, which is
/// more common for camera video) is the correct matrix here.
///
/// This runs on every captured frame - roughly two million pixels at 1080p -
/// so it is the single hottest function in the capture path, and the reason
/// the video loop's frame rate used to be set as low as it was. Three things
/// keep it cheap:
///
///   * **Fixed-point integer math instead of `f32`.** The coefficients below
///     are the same BT.601 full-range values scaled by 256, so the output is
///     the same picture, without per-pixel float multiplies, `round()` and
///     `clamp()`.
///   * **Row slices taken once, not per channel.** Each pixel is read
///     through a fixed 4-byte window, so the three channel reads inside it
///     share a single range check instead of paying one per
///     `bgra[i]`/`bgra[i + 1]`/`bgra[i + 2]`.
///   * **Two rows at a time.** Chroma is 2x2 subsampled, so pairing rows
///     computes it once per block with no `row % 2` test per pixel, and
///     averages the block's four samples rather than point-sampling its
///     top-left corner (visibly cleaner on text and thin lines, which is
///     most of what a desktop is).
fn bgra_to_i420(bgra: &[u8], width: u32, height: u32) -> I420Frame {
    let w = width as usize;
    let h = height as usize;
    let cw = w / 2;
    let mut y_plane = vec![0u8; w * h];
    let mut u_plane = vec![0u8; cw * (h / 2)];
    let mut v_plane = vec![0u8; cw * (h / 2)];

    // BT.601 full range, scaled by 256. `+ 128` in each expression is the
    // rounding term for the `>> 8` that follows.
    #[inline(always)]
    fn luma(r: i32, g: i32, b: i32) -> u8 {
        (((77 * r + 150 * g + 29 * b + 128) >> 8).clamp(0, 255)) as u8
    }

    for row_pair in 0..h / 2 {
        let top = row_pair * 2;
        let bottom = top + 1;

        let (top_src, bottom_src) = (
            &bgra[top * w * 4..(top + 1) * w * 4],
            &bgra[bottom * w * 4..(bottom + 1) * w * 4],
        );

        // Split the Y plane so both rows can be written without re-indexing.
        let (y_top, y_bottom) = {
            let (head, tail) = y_plane.split_at_mut(bottom * w);
            (&mut head[top * w..], &mut tail[..w])
        };

        let u_row = &mut u_plane[row_pair * cw..(row_pair + 1) * cw];
        let v_row = &mut v_plane[row_pair * cw..(row_pair + 1) * cw];

        let mut col = 0;
        let mut chroma_col = 0;
        while col + 1 < w {
            // Four BGRA pixels of one 2x2 block.
            let tl = &top_src[col * 4..col * 4 + 4];
            let tr = &top_src[(col + 1) * 4..(col + 1) * 4 + 4];
            let bl = &bottom_src[col * 4..col * 4 + 4];
            let br = &bottom_src[(col + 1) * 4..(col + 1) * 4 + 4];

            y_top[col] = luma(tl[2] as i32, tl[1] as i32, tl[0] as i32);
            y_top[col + 1] = luma(tr[2] as i32, tr[1] as i32, tr[0] as i32);
            y_bottom[col] = luma(bl[2] as i32, bl[1] as i32, bl[0] as i32);
            y_bottom[col + 1] = luma(br[2] as i32, br[1] as i32, br[0] as i32);

            // Average the block, then convert once - cheaper than converting
            // four times, and less prone to chroma crawl on 1px detail.
            let b = (tl[0] as i32 + tr[0] as i32 + bl[0] as i32 + br[0] as i32) / 4;
            let g = (tl[1] as i32 + tr[1] as i32 + bl[1] as i32 + br[1] as i32) / 4;
            let r = (tl[2] as i32 + tr[2] as i32 + bl[2] as i32 + br[2] as i32) / 4;

            u_row[chroma_col] = ((((-43 * r - 85 * g + 128 * b + 128) >> 8) + 128).clamp(0, 255)) as u8;
            v_row[chroma_col] = ((((128 * r - 107 * g - 21 * b + 128) >> 8) + 128).clamp(0, 255)) as u8;

            col += 2;
            chroma_col += 1;
        }
    }

    I420Frame { width: w, height: h, y: y_plane, u: u_plane, v: v_plane }
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

        // The encoder is resolution-independent at construction time - it
        // takes its dimensions from whatever `YUVSource` is actually passed
        // to `encode()` each call (`I420Frame`, above). 8 Mbps at 30 fps is a
        // starting point for legible screen content at 1080p; OpenH264's
        // default (120 kbps, tuned for low-bitrate video calls) would be
        // illegible for text and UI detail. These two numbers must stay in
        // step with `TARGET_FPS` in session.rs: telling the rate controller
        // 15 while actually feeding it 30 makes it spend its whole budget in
        // the first half second of every second and starve the rest.
        let config = EncoderConfig::new().set_bitrate_bps(8_000_000).max_frame_rate(30.0);
        let encoder =
            Encoder::with_api_config(OpenH264API::from_source(), config).context("initializing OpenH264 encoder")?;
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The float implementation `bgra_to_i420` replaced, kept here purely as
    /// the reference the fast path is checked against. If the two ever
    /// disagree by more than rounding, the fast path is wrong.
    fn reference_luma(r: f32, g: f32, b: f32) -> u8 {
        (0.299 * r + 0.587 * g + 0.114 * b).round().clamp(0.0, 255.0) as u8
    }

    fn bgra_pixel(buf: &mut [u8], w: usize, x: usize, y: usize, r: u8, g: u8, b: u8) {
        let i = (y * w + x) * 4;
        buf[i] = b;
        buf[i + 1] = g;
        buf[i + 2] = r;
        buf[i + 3] = 255;
    }

    #[test]
    fn plane_sizes_match_i420_layout() {
        let (w, h) = (8usize, 6usize);
        let frame = bgra_to_i420(&vec![0u8; w * h * 4], w as u32, h as u32);
        assert_eq!(frame.y.len(), w * h);
        assert_eq!(frame.u.len(), (w / 2) * (h / 2));
        assert_eq!(frame.v.len(), (w / 2) * (h / 2));
        assert_eq!(frame.strides(), (w, w / 2, w / 2));
        assert_eq!(frame.dimensions(), (w, h));
    }

    #[test]
    fn luma_matches_float_reference_across_the_colour_cube() {
        // Every pixel distinct, so a transposed or mis-strided write shows up
        // as a mismatch rather than coincidentally passing.
        let (w, h) = (16usize, 16usize);
        let mut bgra = vec![0u8; w * h * 4];
        for y in 0..h {
            for x in 0..w {
                bgra_pixel(&mut bgra, w, x, y, (x * 16) as u8, (y * 16) as u8, ((x + y) * 8) as u8);
            }
        }

        let frame = bgra_to_i420(&bgra, w as u32, h as u32);

        for y in 0..h {
            for x in 0..w {
                let expected = reference_luma((x * 16) as f32, (y * 16) as f32, ((x + y) * 8) as f32);
                let actual = frame.y[y * w + x];
                assert!(
                    (actual as i32 - expected as i32).abs() <= 1,
                    "luma mismatch at ({x},{y}): got {actual}, reference {expected}"
                );
            }
        }
    }

    #[test]
    fn greyscale_is_neutral_and_extremes_are_preserved() {
        let (w, h) = (4usize, 4usize);
        let mut bgra = vec![0u8; w * h * 4];
        for y in 0..h {
            for x in 0..w {
                bgra_pixel(&mut bgra, w, x, y, 128, 128, 128);
            }
        }
        let grey = bgra_to_i420(&bgra, w as u32, h as u32);
        // Grey carries no colour: both chroma planes sit at the 128 midpoint.
        assert!(grey.u.iter().all(|&u| (u as i32 - 128).abs() <= 1), "u drifted off neutral: {:?}", grey.u);
        assert!(grey.v.iter().all(|&v| (v as i32 - 128).abs() <= 1), "v drifted off neutral: {:?}", grey.v);
        assert!(grey.y.iter().all(|&y| (y as i32 - 128).abs() <= 1), "grey luma wrong: {:?}", grey.y);

        for (r, g, b, expect_y) in [(0u8, 0u8, 0u8, 0u8), (255, 255, 255, 255)] {
            let mut buf = vec![0u8; w * h * 4];
            for y in 0..h {
                for x in 0..w {
                    bgra_pixel(&mut buf, w, x, y, r, g, b);
                }
            }
            let frame = bgra_to_i420(&buf, w as u32, h as u32);
            assert!(
                frame.y.iter().all(|&y| (y as i32 - expect_y as i32).abs() <= 1),
                "({r},{g},{b}) should encode to luma ~{expect_y}, got {:?}",
                &frame.y[..4]
            );
        }
    }

    #[test]
    fn chroma_separates_primaries() {
        // Red and blue sit on opposite sides of both chroma axes; if the two
        // planes were swapped or the coefficients transposed, this fails.
        let (w, h) = (2usize, 2usize);
        let mut red = vec![0u8; w * h * 4];
        let mut blue = vec![0u8; w * h * 4];
        for y in 0..h {
            for x in 0..w {
                bgra_pixel(&mut red, w, x, y, 255, 0, 0);
                bgra_pixel(&mut blue, w, x, y, 0, 0, 255);
            }
        }

        let red = bgra_to_i420(&red, w as u32, h as u32);
        let blue = bgra_to_i420(&blue, w as u32, h as u32);

        // Checked against the float matrix rather than round numbers: the
        // axes are not symmetric, so e.g. blue's V lands at ~107, only 21
        // below neutral, while red's V saturates at 255.
        let reference_u = |r: f32, g: f32, b: f32| (-0.169 * r - 0.331 * g + 0.5 * b + 128.0).clamp(0.0, 255.0);
        let reference_v = |r: f32, g: f32, b: f32| (0.5 * r - 0.419 * g - 0.081 * b + 128.0).clamp(0.0, 255.0);

        for (label, frame, r, g, b) in [
            ("red", &red, 255.0, 0.0, 0.0),
            ("blue", &blue, 0.0, 0.0, 255.0),
        ] {
            let (want_u, want_v) = (reference_u(r, g, b), reference_v(r, g, b));
            assert!(
                (frame.u[0] as f32 - want_u).abs() <= 1.5,
                "{label}: u was {}, reference {want_u}",
                frame.u[0]
            );
            assert!(
                (frame.v[0] as f32 - want_v).abs() <= 1.5,
                "{label}: v was {}, reference {want_v}",
                frame.v[0]
            );
        }

        // Directionally, the two primaries must land on opposite sides of
        // both axes - this is what catches a U/V swap, which per-channel
        // tolerance checks alone would not.
        assert!(red.v[0] > blue.v[0], "red must sit above blue on the V axis");
        assert!(blue.u[0] > red.u[0], "blue must sit above red on the U axis");
    }

    #[test]
    fn chroma_averages_the_whole_block() {
        // A 2x2 block that is half black, half white must average to mid-grey
        // chroma rather than taking whatever happens to be in the top-left.
        let (w, h) = (2usize, 2usize);
        let mut bgra = vec![0u8; w * h * 4];
        bgra_pixel(&mut bgra, w, 0, 0, 255, 0, 0); // red
        bgra_pixel(&mut bgra, w, 1, 0, 0, 255, 0); // green
        bgra_pixel(&mut bgra, w, 0, 1, 0, 0, 255); // blue
        bgra_pixel(&mut bgra, w, 1, 1, 255, 255, 255); // white

        let frame = bgra_to_i420(&bgra, w as u32, h as u32);
        // Averaged block is (128,128,128)-ish, so chroma lands near neutral.
        assert!((frame.u[0] as i32 - 128).abs() <= 12, "u should be near neutral, got {}", frame.u[0]);
        assert!((frame.v[0] as i32 - 128).abs() <= 12, "v should be near neutral, got {}", frame.v[0]);
        // ...while each pixel keeps its own distinct luma.
        assert_eq!(frame.y.len(), 4);
        assert!(frame.y[0] != frame.y[1], "per-pixel luma must not be averaged away");
    }
}
