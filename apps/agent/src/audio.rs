//! WASAPI audio capture, encoded to Opus for a WebRTC audio track. Two
//! sources share this one implementation:
//!
//!   - **Loopback** ("what this computer plays", Phase 3's remote audio):
//!     opens the default *render* (speaker) endpoint with
//!     `AUDCLNT_STREAMFLAGS_LOOPBACK`, which hands back a copy of whatever
//!     that endpoint is mixing rather than actually capturing a microphone.
//!   - **Microphone** (Phase 4, explicitly consented per session - see
//!     `session.rs::grant_microphone`): opens the default *capture* endpoint
//!     with no special flags, i.e. an ordinary recording stream. This is a
//!     real microphone activation and goes through the OS's own privacy
//!     surface exactly like any other application recording audio would - it
//!     is not a way around the microphone privacy indicator Windows shows.
//!
//! This is one of the highest-FFI-risk files in the agent, for the same
//! reason `capture.rs` is: it drives Windows COM interfaces
//! (`IMMDeviceEnumerator`, `IAudioClient`, `IAudioCaptureClient`) directly.
//!
//! Known simplifying assumption, stated plainly rather than silently baked
//! in: the endpoint's shared-mode mix format is assumed to be 32-bit float
//! PCM at a sample rate Opus accepts natively (8/12/16/24/48 kHz - in
//! practice this is 48 kHz on the overwhelming majority of Windows installs
//! and devices). A device with an unusual mix format is refused with a clear
//! error rather than silently producing noise; full format negotiation and
//! resampling is future work.

use anyhow::{bail, Context, Result};
use windows::Win32::Media::Audio::{
    eCapture, eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator, MMDeviceEnumerator,
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};

/// One 10ms WASAPI buffer period; small enough to keep audio latency low
/// without polling so tightly that it wastes CPU.
const BUFFER_DURATION_HNS: i64 = 100_000; // 10ms in 100-nanosecond units

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum AudioSource {
    /// The default playback device, opened in loopback mode.
    SystemLoopback,
    /// The default recording device (an actual microphone), opened normally.
    Microphone,
}

pub struct AudioCapture {
    client: IAudioClient,
    capture_client: IAudioCaptureClient,
    pub sample_rate: u32,
    pub channels: u16,
}

impl AudioCapture {
    pub fn loopback() -> Result<Self> {
        Self::open(AudioSource::SystemLoopback)
    }

    pub fn microphone() -> Result<Self> {
        Self::open(AudioSource::Microphone)
    }

    /// Must be called on the same OS thread that will subsequently call
    /// `next_samples` - COM apartments and the interfaces obtained here are
    /// thread-affine in the way this code uses them (STA-like usage on a
    /// dedicated thread, matching `capture.rs`'s approach for DXGI).
    fn open(source: AudioSource) -> Result<Self> {
        unsafe {
            // Idempotent-enough for this agent's lifetime: this is the only
            // thread that touches COM, and it never calls CoUninitialize
            // since the thread lives as long as the capture does.
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

            let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                .context("creating IMMDeviceEnumerator")?;
            let data_flow = if source == AudioSource::Microphone { eCapture } else { eRender };
            let endpoint_kind = if source == AudioSource::Microphone { "recording" } else { "playback" };
            let device = enumerator
                .GetDefaultAudioEndpoint(data_flow, eConsole)
                .with_context(|| format!("getting the default {endpoint_kind} device - is one set as default?"))?;
            let client: IAudioClient = device.Activate(CLSCTX_ALL, None).context("activating IAudioClient")?;

            let mix_format = client.GetMixFormat().context("getting the device's mix format")?;
            let (sample_rate, channels, bits_per_sample) = {
                let format = &*mix_format;
                (format.nSamplesPerSec, format.nChannels, format.wBitsPerSample)
            };

            // Validated *before* Initialize, but the format buffer itself is
            // still needed by Initialize below regardless of which way this
            // goes, so freeing it waits until after that call (see the
            // CoTaskMemFree at the end of this block) - freeing it here would
            // hand Initialize a dangling pointer on the success path.
            if bits_per_sample != 32 {
                windows::Win32::System::Com::CoTaskMemFree(Some(mix_format as *const _ as *const std::ffi::c_void));
                bail!(
                    "unsupported mix format: {bits_per_sample}-bit samples (only 32-bit float is \
                     supported in this phase - see the module doc comment in audio.rs)"
                );
            }
            if !matches!(sample_rate, 8000 | 12000 | 16000 | 24000 | 48000) {
                windows::Win32::System::Com::CoTaskMemFree(Some(mix_format as *const _ as *const std::ffi::c_void));
                bail!("unsupported mix format: {sample_rate} Hz is not a rate Opus accepts natively");
            }

            // Stream flags are a plain u32 bitmask in this crate version, not
            // a dedicated flags type - AUDCLNT_STREAMFLAGS_LOOPBACK is itself
            // just a `u32` constant, and "no flags" for microphone capture is
            // simply 0.
            let stream_flags: u32 = if source == AudioSource::SystemLoopback { AUDCLNT_STREAMFLAGS_LOOPBACK } else { 0 };
            let init_result = client.Initialize(AUDCLNT_SHAREMODE_SHARED, stream_flags, BUFFER_DURATION_HNS, 0, mix_format, None);
            // GetMixFormat allocates with CoTaskMemAlloc; the caller owns it,
            // and nothing after this point still needs the pointer.
            windows::Win32::System::Com::CoTaskMemFree(Some(mix_format as *const _ as *const std::ffi::c_void));
            init_result.context("initializing IAudioClient")?;

            let capture_client: IAudioCaptureClient = client.GetService().context("getting IAudioCaptureClient")?;
            client.Start().context("starting audio capture")?;

            Ok(Self { client, capture_client, sample_rate, channels })
        }
    }

    /// Blocks the calling thread briefly (one buffer period) and returns
    /// whatever interleaved f32 samples became available, if any. An empty
    /// result is normal during silence - WASAPI simply has nothing to hand
    /// back, which is not the same as an error.
    pub fn next_samples(&self) -> Result<Vec<f32>> {
        std::thread::sleep(std::time::Duration::from_millis(10));

        let mut all_samples = Vec::new();
        loop {
            let packet_size = unsafe { self.capture_client.GetNextPacketSize() }.context("GetNextPacketSize failed")?;
            if packet_size == 0 {
                break;
            }

            let mut data_ptr = std::ptr::null_mut();
            let mut num_frames = 0u32;
            let mut flags = 0u32;
            unsafe {
                self.capture_client
                    .GetBuffer(&mut data_ptr, &mut num_frames, &mut flags, None, None)
                    .context("GetBuffer failed")?;
            }

            let sample_count = num_frames as usize * self.channels as usize;
            if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || data_ptr.is_null() {
                all_samples.resize(all_samples.len() + sample_count, 0.0);
            } else {
                let samples = unsafe { std::slice::from_raw_parts(data_ptr as *const f32, sample_count) };
                all_samples.extend_from_slice(samples);
            }

            unsafe {
                self.capture_client.ReleaseBuffer(num_frames).context("ReleaseBuffer failed")?;
            }
        }

        Ok(all_samples)
    }
}

impl Drop for AudioCapture {
    fn drop(&mut self) {
        unsafe {
            let _ = self.client.Stop();
        }
    }
}

// SAFETY: used from a single dedicated capture thread throughout this agent
// (see session.rs), matching the same justification as `ScreenCapture`.
unsafe impl Send for AudioCapture {}

pub struct OpusEncoder {
    encoder: audiopus::coder::Encoder,
    channels: usize,
}

impl OpusEncoder {
    pub fn new(sample_rate: u32, channels: u16) -> Result<Self> {
        let rate = match sample_rate {
            8000 => audiopus::SampleRate::Hz8000,
            12000 => audiopus::SampleRate::Hz12000,
            16000 => audiopus::SampleRate::Hz16000,
            24000 => audiopus::SampleRate::Hz24000,
            48000 => audiopus::SampleRate::Hz48000,
            other => bail!("unsupported sample rate for Opus: {other}"),
        };
        let opus_channels = match channels {
            1 => audiopus::Channels::Mono,
            2 => audiopus::Channels::Stereo,
            other => bail!("unsupported channel count for Opus: {other}"),
        };

        let encoder = audiopus::coder::Encoder::new(rate, opus_channels, audiopus::Application::Audio)
            .context("initializing Opus encoder")?;

        Ok(Self { encoder, channels: channels as usize })
    }

    /// Encodes one Opus frame from interleaved f32 samples. `samples` must
    /// contain a duration Opus supports per frame (2.5/5/10/20/40/60ms) -
    /// the caller (session.rs) buffers WASAPI's 10ms packets up to a fixed
    /// 20ms frame size before calling this, since WASAPI's delivery cadence
    /// is not guaranteed to line up with Opus's frame-size requirements.
    pub fn encode(&mut self, samples: &[f32]) -> Result<Vec<u8>> {
        anyhow::ensure!(samples.len() % self.channels == 0, "sample buffer is not a whole number of frames");
        let mut output = vec![0u8; 4000]; // generous upper bound for one Opus frame
        let len = self.encoder.encode_float(samples, &mut output).context("Opus encode failed")?;
        output.truncate(len);
        Ok(output)
    }
}
