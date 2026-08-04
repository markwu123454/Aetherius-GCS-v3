//! ArduPilot's serial bootloader protocol — a Rust port of the `uploader`
//! and `firmware` classes in ArduPilot's own `Tools/scripts/uploader.py`
//! (https://github.com/ArduPilot/ardupilot/blob/master/Tools/scripts/uploader.py),
//! the reference implementation ArduPilot maintains and tests against every
//! board they ship.
//!
//! Deliberately narrower than the Python original:
//! - Only bootloader protocol revision 3+ is supported (CRC-based verify).
//!   Revision 2 (raw read-back verify) predates any board still shipping
//!   today; an older bootloader is rejected with `UnsupportedBootloaderRevision`
//!   rather than silently guessing at compatibility.
//! - External flash (`extf_image`, used for QSPI-equipped boards' scripting/
//!   logging partitions, not the flight firmware itself) isn't handled — an
//!   `.apj` that declares one is rejected with `ExternalFlashUnsupported`
//!   rather than doing a partial flash.
//! - OTP/chip-ID/board-name diagnostics (`--identify` in the Python tool)
//!   aren't ported — informational only, never used by a normal upload.
//! - `boot_delay` and the `compatible_IDs` cross-board-ID allowance aren't
//!   ported — narrow conveniences, not part of the core flash sequence.
//!
//! Every command/response is exactly what real ArduPilot bootloaders speak,
//! transcribed from the Python source rather than reconstructed from
//! protocol descriptions — see `tests` for cross-checked CRC vectors.

use std::fmt;
use std::io::{self, Read};
use std::time::{Duration, Instant};

use base64::Engine;
use flate2::read::ZlibDecoder;
use serde::Deserialize;

// ---------------------------------------------------------------------
// CRC32 — ArduPilot's own `crc_crc32()` (AP_Math/crc.cpp), NOT the
// standard zlib/zip CRC-32: same reflected table and polynomial, but
// initial state 0 (not 0xFFFFFFFF) and no final XOR. Using a generic
// CRC-32 crate here would silently compute the wrong number, since it's a
// different variant, not a parameter you can casually rediscover by
// reading firmware output. Table transcribed verbatim from `uploader.py`'s
// `crctab`; cross-checked against vectors computed by running that exact
// Python table+function (see `tests::crc32_matches_reference_vectors`).
// ---------------------------------------------------------------------

#[rustfmt::skip]
const CRC_TABLE: [u32; 256] = [
    0x00000000, 0x77073096, 0xee0e612c, 0x990951ba, 0x076dc419, 0x706af48f, 0xe963a535, 0x9e6495a3,
    0x0edb8832, 0x79dcb8a4, 0xe0d5e91e, 0x97d2d988, 0x09b64c2b, 0x7eb17cbd, 0xe7b82d07, 0x90bf1d91,
    0x1db71064, 0x6ab020f2, 0xf3b97148, 0x84be41de, 0x1adad47d, 0x6ddde4eb, 0xf4d4b551, 0x83d385c7,
    0x136c9856, 0x646ba8c0, 0xfd62f97a, 0x8a65c9ec, 0x14015c4f, 0x63066cd9, 0xfa0f3d63, 0x8d080df5,
    0x3b6e20c8, 0x4c69105e, 0xd56041e4, 0xa2677172, 0x3c03e4d1, 0x4b04d447, 0xd20d85fd, 0xa50ab56b,
    0x35b5a8fa, 0x42b2986c, 0xdbbbc9d6, 0xacbcf940, 0x32d86ce3, 0x45df5c75, 0xdcd60dcf, 0xabd13d59,
    0x26d930ac, 0x51de003a, 0xc8d75180, 0xbfd06116, 0x21b4f4b5, 0x56b3c423, 0xcfba9599, 0xb8bda50f,
    0x2802b89e, 0x5f058808, 0xc60cd9b2, 0xb10be924, 0x2f6f7c87, 0x58684c11, 0xc1611dab, 0xb6662d3d,
    0x76dc4190, 0x01db7106, 0x98d220bc, 0xefd5102a, 0x71b18589, 0x06b6b51f, 0x9fbfe4a5, 0xe8b8d433,
    0x7807c9a2, 0x0f00f934, 0x9609a88e, 0xe10e9818, 0x7f6a0dbb, 0x086d3d2d, 0x91646c97, 0xe6635c01,
    0x6b6b51f4, 0x1c6c6162, 0x856530d8, 0xf262004e, 0x6c0695ed, 0x1b01a57b, 0x8208f4c1, 0xf50fc457,
    0x65b0d9c6, 0x12b7e950, 0x8bbeb8ea, 0xfcb9887c, 0x62dd1ddf, 0x15da2d49, 0x8cd37cf3, 0xfbd44c65,
    0x4db26158, 0x3ab551ce, 0xa3bc0074, 0xd4bb30e2, 0x4adfa541, 0x3dd895d7, 0xa4d1c46d, 0xd3d6f4fb,
    0x4369e96a, 0x346ed9fc, 0xad678846, 0xda60b8d0, 0x44042d73, 0x33031de5, 0xaa0a4c5f, 0xdd0d7cc9,
    0x5005713c, 0x270241aa, 0xbe0b1010, 0xc90c2086, 0x5768b525, 0x206f85b3, 0xb966d409, 0xce61e49f,
    0x5edef90e, 0x29d9c998, 0xb0d09822, 0xc7d7a8b4, 0x59b33d17, 0x2eb40d81, 0xb7bd5c3b, 0xc0ba6cad,
    0xedb88320, 0x9abfb3b6, 0x03b6e20c, 0x74b1d29a, 0xead54739, 0x9dd277af, 0x04db2615, 0x73dc1683,
    0xe3630b12, 0x94643b84, 0x0d6d6a3e, 0x7a6a5aa8, 0xe40ecf0b, 0x9309ff9d, 0x0a00ae27, 0x7d079eb1,
    0xf00f9344, 0x8708a3d2, 0x1e01f268, 0x6906c2fe, 0xf762575d, 0x806567cb, 0x196c3671, 0x6e6b06e7,
    0xfed41b76, 0x89d32be0, 0x10da7a5a, 0x67dd4acc, 0xf9b9df6f, 0x8ebeeff9, 0x17b7be43, 0x60b08ed5,
    0xd6d6a3e8, 0xa1d1937e, 0x38d8c2c4, 0x4fdff252, 0xd1bb67f1, 0xa6bc5767, 0x3fb506dd, 0x48b2364b,
    0xd80d2bda, 0xaf0a1b4c, 0x36034af6, 0x41047a60, 0xdf60efc3, 0xa867df55, 0x316e8eef, 0x4669be79,
    0xcb61b38c, 0xbc66831a, 0x256fd2a0, 0x5268e236, 0xcc0c7795, 0xbb0b4703, 0x220216b9, 0x5505262f,
    0xc5ba3bbe, 0xb2bd0b28, 0x2bb45a92, 0x5cb36a04, 0xc2d7ffa7, 0xb5d0cf31, 0x2cd99e8b, 0x5bdeae1d,
    0x9b64c2b0, 0xec63f226, 0x756aa39c, 0x026d930a, 0x9c0906a9, 0xeb0e363f, 0x72076785, 0x05005713,
    0x95bf4a82, 0xe2b87a14, 0x7bb12bae, 0x0cb61b38, 0x92d28e9b, 0xe5d5be0d, 0x7cdcefb7, 0x0bdbdf21,
    0x86d3d2d4, 0xf1d4e242, 0x68ddb3f8, 0x1fda836e, 0x81be16cd, 0xf6b9265b, 0x6fb077e1, 0x18b74777,
    0x88085ae6, 0xff0f6a70, 0x66063bca, 0x11010b5c, 0x8f659eff, 0xf862ae69, 0x616bffd3, 0x166ccf45,
    0xa00ae278, 0xd70dd2ee, 0x4e048354, 0x3903b3c2, 0xa7672661, 0xd06016f7, 0x4969474d, 0x3e6e77db,
    0xaed16a4a, 0xd9d65adc, 0x40df0b66, 0x37d83bf0, 0xa9bcae53, 0xdebb9ec5, 0x47b2cf7f, 0x30b5ffe9,
    0xbdbdf21c, 0xcabac28a, 0x53b39330, 0x24b4a3a6, 0xbad03605, 0xcdd70693, 0x54de5729, 0x23d967bf,
    0xb3667a2e, 0xc4614ab8, 0x5d681b02, 0x2a6f2b94, 0xb40bbe37, 0xc30c8ea1, 0x5a05df1b, 0x2d02ef8d,
];

fn crc32(bytes: &[u8], mut state: u32) -> u32 {
    for &byte in bytes {
        let index = ((state ^ byte as u32) & 0xff) as usize;
        state = CRC_TABLE[index] ^ (state >> 8);
    }
    state
}

// ---------------------------------------------------------------------
// .apj firmware file — JSON header plus a base64+zlib-compressed image.
// ---------------------------------------------------------------------

#[derive(Deserialize)]
struct ApjDesc {
    image: String,
    image_size: u64,
    board_id: u32,
    #[serde(default)]
    board_revision: u32,
    /// Present on *every* real ArduPilot `.apj` — but almost always as an
    /// empty placeholder (`extf_image_size: 0`, a zlib stream that
    /// decompresses to nothing). Its mere presence says nothing about
    /// whether the build actually targets external flash, so this is
    /// decompressed and measured rather than tested for existence.
    extf_image: Option<String>,
}

#[derive(Clone)]
pub struct ApjFirmware {
    /// Decompressed image, padded to a 4-byte boundary with 0xFF — matches
    /// `firmware.__init__`'s own padding in `uploader.py`, needed because
    /// `PROG_MULTI` writes whole 32-bit words.
    pub image: Vec<u8>,
    /// As declared in the file (pre-padding) — used for the "does it fit"
    /// check against the board's reported flash size.
    pub image_size: u64,
    pub board_id: u32,
    pub board_revision: u32,
    pub has_external_flash_image: bool,
}

/// Hard ceiling on a decompressed `.apj` image. The largest flight
/// controllers ArduPilot ships have 2 MB of flash, so anything approaching
/// this is either a corrupt file or a compression bomb — and `read_to_end`
/// on a `ZlibDecoder` is otherwise happy to allocate until the process dies.
const MAX_IMAGE_BYTES: u64 = 32 * 1024 * 1024;

/// base64 → zlib → bytes, the encoding `.apj` uses for both its image
/// fields, capped so a corrupt or hostile file can't allocate the process
/// to death.
fn decode_apj_image(encoded: &str, field: &str) -> Result<Vec<u8>, UploadError> {
    let compressed = base64::engine::general_purpose::STANDARD
        .decode(encoded.as_bytes())
        .map_err(|e| UploadError::Apj(format!("bad base64 in .apj {field} field: {e}")))?;

    let mut out = Vec::new();
    ZlibDecoder::new(&compressed[..])
        .take(MAX_IMAGE_BYTES + 1)
        .read_to_end(&mut out)
        .map_err(|e| UploadError::Apj(format!("could not decompress .apj {field}: {e}")))?;

    if out.len() as u64 > MAX_IMAGE_BYTES {
        return Err(UploadError::Apj(format!(
            "the .apj's {field} decompresses to more than {MAX_IMAGE_BYTES} bytes — refusing to treat it as firmware"
        )));
    }
    Ok(out)
}

impl ApjFirmware {
    pub fn parse(bytes: &[u8]) -> Result<Self, UploadError> {
        let desc: ApjDesc =
            serde_json::from_slice(bytes).map_err(|e| UploadError::Apj(format!("not a valid .apj file: {e}")))?;

        let mut image = decode_apj_image(&desc.image, "image")?;

        // Measured, not merely detected: every real ArduPilot .apj carries
        // an `extf_image` key, and on all of them checked (Pixhawk1, 6C, 6X,
        // Cube Black/Orange/Orange+, Durandal, MatekH743) it decompresses to
        // zero bytes with `extf_image_size: 0`. Treating the key's presence
        // as "this build targets external flash" rejects every board there
        // is.
        let external_flash_bytes = match desc.extf_image.as_deref() {
            Some(encoded) => decode_apj_image(encoded, "extf_image")?.len(),
            None => 0,
        };

        // The header's `image_size` is what every size check downstream is
        // written against, so a file whose header disagrees with its own
        // payload is rejected here rather than erasing a board on the
        // strength of a number the payload doesn't back up.
        if image.len() as u64 != desc.image_size {
            return Err(UploadError::Apj(format!(
                "corrupt .apj: header declares image_size={} but the image decompresses to {} bytes",
                desc.image_size,
                image.len()
            )));
        }

        while image.len() % 4 != 0 {
            image.push(0xFF);
        }

        Ok(Self {
            image,
            image_size: desc.image_size,
            board_id: desc.board_id,
            board_revision: desc.board_revision,
            has_external_flash_image: external_flash_bytes > 0,
        })
    }

    /// CRC over the image plus 0xFF padding out to `padlen` bytes — mirrors
    /// `firmware.crc()`. `padlen` must be the board's *flash size*, not the
    /// image size: after a chip erase the whole flash region reads as 0xFF,
    /// and programming only overwrites the image's own bytes, so the
    /// board's own on-chip CRC (`GET_CRC`) covers everything up to flash
    /// size, not just what was written. Padding to anything narrower would
    /// make this never match a real board's report.
    pub fn crc(&self, padlen: u32) -> u32 {
        let mut state = crc32(&self.image, 0);
        let mut i = self.image.len() as u32;
        while i < padlen.saturating_sub(1) {
            state = crc32(&[0xFF, 0xFF, 0xFF, 0xFF], state);
            i += 4;
        }
        state
    }
}

// ---------------------------------------------------------------------
// Transport — abstracts the serial port so the protocol logic can run
// against a real port or, in tests, a fake bootloader with no hardware.
// ---------------------------------------------------------------------

pub trait Transport {
    fn write_all(&mut self, data: &[u8]) -> io::Result<()>;
    fn read_exact(&mut self, buf: &mut [u8]) -> io::Result<()>;
    /// Discards any bytes already sitting in the input buffer — mirrors
    /// pyserial's `flushInput()`, used before a sync attempt so a stale
    /// half-conversation left over from a previous, aborted attempt can't
    /// be mistaken for a real response.
    fn discard_input(&mut self) -> io::Result<()>;
}

pub struct SerialTransport(Box<dyn serialport::SerialPort>);

impl SerialTransport {
    pub fn new(port: Box<dyn serialport::SerialPort>) -> Self {
        Self(port)
    }

    /// Scanning for a bootloader across every port wants a short read
    /// timeout so a silent port is abandoned quickly; the flash that
    /// follows wants a long one. This lets the handle that found the
    /// bootloader be promoted in place, rather than closed and re-opened —
    /// a board whose application firmware is intact only holds in its
    /// bootloader for a few seconds, so giving that window back is a real
    /// risk.
    pub fn set_timeout(&mut self, timeout: Duration) -> io::Result<()> {
        self.0.set_timeout(timeout).map_err(|e| io::Error::new(io::ErrorKind::Other, e))
    }
}

impl Transport for SerialTransport {
    fn write_all(&mut self, data: &[u8]) -> io::Result<()> {
        io::Write::write_all(&mut self.0, data)
    }

    fn read_exact(&mut self, buf: &mut [u8]) -> io::Result<()> {
        io::Read::read_exact(&mut self.0, buf)
    }

    fn discard_input(&mut self) -> io::Result<()> {
        self.0
            .clear(serialport::ClearBuffer::Input)
            .map_err(|e| io::Error::new(io::ErrorKind::Other, e))
    }
}

// ---------------------------------------------------------------------
// Protocol constants — transcribed verbatim from `uploader.py`'s
// `uploader` class (the single-byte command/reply values a real
// bootloader speaks; not something invented here).
// ---------------------------------------------------------------------

const INSYNC: u8 = 0x12;
const EOC: u8 = 0x20;

const OK: u8 = 0x10;
const FAILED: u8 = 0x11;
const INVALID: u8 = 0x13;
/// rev5+. The bootloader reports this instead of OK when the chip is a
/// silicon revision that can't be programmed reliably (the STM32F4 flash
/// erratum). It has to be distinguished from "no answer yet": it's returned
/// in place of the OK that ends an erase handshake, so treating it as a
/// silent board turns a precise, actionable failure into a 20-second
/// timeout blamed on the cable.
const BAD_SILICON_REV: u8 = 0x14;

const GET_SYNC: u8 = 0x21;
const GET_DEVICE: u8 = 0x22;
const CHIP_ERASE: u8 = 0x23;
const PROG_MULTI: u8 = 0x27;
const GET_CRC: u8 = 0x29;
const REBOOT: u8 = 0x30;

const INFO_BL_REV: u8 = 0x01;
const INFO_BOARD_ID: u8 = 0x02;
const INFO_BOARD_REV: u8 = 0x03;
const INFO_FLASH_SIZE: u8 = 0x04;

const PROG_MULTI_MAX: usize = 252; // protocol max is 255, must be a multiple of 4

const MIN_SUPPORTED_BL_REV: u32 = 3; // rev 2's raw-read verify isn't ported — see module docs
const MAX_KNOWN_BL_REV: u32 = 5;

const ERASE_TIMEOUT: Duration = Duration::from_secs(20); // erase is slow; `uploader.py` allows the same
const ERASE_POLL_INTERVAL: Duration = Duration::from_millis(50);

#[derive(Debug)]
pub enum UploadError {
    Io(io::Error),
    /// No response within the transport's read timeout.
    Timeout,
    UnexpectedResponse { expected: &'static str, got: u8 },
    BootloaderReportedFailure,
    BootloaderReportedInvalidOperation,
    /// The chip's silicon revision can't be programmed reliably.
    BadSiliconRevision,
    UnsupportedBootloaderRevision(u32),
    BoardMismatch { board_expects: u32, firmware_targets: u32 },
    ImageTooLarge { image_size: u64, flash_size: u32 },
    ExternalFlashUnsupported,
    CrcMismatch { expected: u32, reported: u32 },
    Apj(String),
}

impl From<io::Error> for UploadError {
    fn from(e: io::Error) -> Self {
        if e.kind() == io::ErrorKind::TimedOut || e.kind() == io::ErrorKind::UnexpectedEof {
            UploadError::Timeout
        } else {
            UploadError::Io(e)
        }
    }
}

impl fmt::Display for UploadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            UploadError::Io(e) => write!(f, "serial I/O error: {e}"),
            UploadError::Timeout => write!(f, "timed out waiting for the bootloader to respond"),
            UploadError::UnexpectedResponse { expected, got } => {
                write!(f, "unexpected response 0x{got:02x} instead of {expected}")
            }
            UploadError::BootloaderReportedFailure => write!(f, "bootloader reports OPERATION FAILED"),
            UploadError::BootloaderReportedInvalidOperation => write!(f, "bootloader reports INVALID OPERATION"),
            UploadError::BadSiliconRevision => write!(
                f,
                "this board's silicon revision can't be programmed reliably — see https://pixhawk.org/help/errata"
            ),
            UploadError::UnsupportedBootloaderRevision(rev) => {
                write!(f, "unsupported bootloader protocol revision {rev} (need {MIN_SUPPORTED_BL_REV}-{MAX_KNOWN_BL_REV})")
            }
            UploadError::BoardMismatch { board_expects, firmware_targets } => write!(
                f,
                "firmware is for board_id={firmware_targets}, but the connected board reports board_id={board_expects}"
            ),
            UploadError::ImageTooLarge { image_size, flash_size } => {
                write!(f, "firmware image ({image_size} bytes) is too large for this board's flash ({flash_size} bytes)")
            }
            UploadError::ExternalFlashUnsupported => {
                write!(f, "this .apj targets external flash, which isn't supported yet")
            }
            UploadError::CrcMismatch { expected, reported } => {
                write!(f, "post-program CRC check failed: expected 0x{expected:08x}, board reports 0x{reported:08x}")
            }
            UploadError::Apj(msg) => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for UploadError {}

#[derive(Debug, Clone, Copy)]
pub struct BoardInfo {
    pub bootloader_rev: u32,
    pub board_id: u32,
    pub flash_size: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UploadStage {
    Identify,
    Erase,
    Program,
    Verify,
    Reboot,
}

/// Talks the protocol over one `Transport`. Every method here is a direct
/// counterpart of a private method on `uploader.py`'s `uploader` class.
struct Uploader<'a, T: Transport> {
    transport: &'a mut T,
}

impl<'a, T: Transport> Uploader<'a, T> {
    fn new(transport: &'a mut T) -> Self {
        Self { transport }
    }

    fn recv_byte(&mut self) -> Result<u8, UploadError> {
        let mut buf = [0u8; 1];
        self.transport.read_exact(&mut buf)?;
        Ok(buf[0])
    }

    fn recv_u32(&mut self) -> Result<u32, UploadError> {
        let mut buf = [0u8; 4];
        self.transport.read_exact(&mut buf)?;
        Ok(u32::from_le_bytes(buf))
    }

    /// Reads the INSYNC+OK (or INSYNC+FAILED/INVALID) that terminates every
    /// bootloader reply.
    fn get_sync(&mut self) -> Result<(), UploadError> {
        let c = self.recv_byte()?;
        if c != INSYNC {
            return Err(UploadError::UnexpectedResponse { expected: "INSYNC", got: c });
        }
        let c = self.recv_byte()?;
        match c {
            OK => Ok(()),
            INVALID => Err(UploadError::BootloaderReportedInvalidOperation),
            FAILED => Err(UploadError::BootloaderReportedFailure),
            BAD_SILICON_REV => Err(UploadError::BadSiliconRevision),
            other => Err(UploadError::UnexpectedResponse { expected: "OK", got: other }),
        }
    }

    /// Same handshake as `get_sync`, but treats a non-answer (wrong byte,
    /// timeout, I/O error) as "not synced yet" rather than a hard failure —
    /// used while polling for the bootloader to become ready again (e.g.
    /// after an erase), where silence just means "still busy".
    ///
    /// `BAD_SILICON_REV` is the one reply that must not be swallowed that
    /// way: it's a definite answer meaning "this chip cannot be programmed",
    /// so it propagates as an error instead of looping until the caller's
    /// deadline. `uploader.py`'s `__trySync` singles it out for the same
    /// reason.
    fn try_sync(&mut self) -> Result<bool, UploadError> {
        match self.recv_byte() {
            Ok(INSYNC) => {}
            _ => return Ok(false),
        }
        match self.recv_byte() {
            Ok(OK) => Ok(true),
            Ok(BAD_SILICON_REV) => Err(UploadError::BadSiliconRevision),
            _ => Ok(false),
        }
    }

    fn sync(&mut self) -> Result<(), UploadError> {
        self.transport.discard_input()?;
        self.transport.write_all(&[GET_SYNC, EOC])?;
        self.get_sync()
    }

    fn get_info(&mut self, param: u8) -> Result<u32, UploadError> {
        self.transport.write_all(&[GET_DEVICE, param, EOC])?;
        let value = self.recv_u32()?;
        self.get_sync()?;
        Ok(value)
    }

    fn identify(&mut self) -> Result<BoardInfo, UploadError> {
        self.sync()?;
        let bootloader_rev = self.get_info(INFO_BL_REV)?;
        if !(MIN_SUPPORTED_BL_REV..=MAX_KNOWN_BL_REV).contains(&bootloader_rev) {
            return Err(UploadError::UnsupportedBootloaderRevision(bootloader_rev));
        }
        let board_id = self.get_info(INFO_BOARD_ID)?;
        let flash_size = self.get_info(INFO_FLASH_SIZE)?;
        Ok(BoardInfo { bootloader_rev, board_id, flash_size })
    }

    /// No progress callback, deliberately. The bootloader is silent for the
    /// entire erase — it sends nothing until it answers INSYNC+OK — so
    /// there is no progress to report. `uploader.py` draws a bar here
    /// against a hardcoded ~9s guess; that bar is a timer wearing a
    /// progress bar's clothes, and an operator reading it as "how much of
    /// my flash is erased" is being misled. The UI shows an indeterminate
    /// state instead.
    fn erase(&mut self) -> Result<(), UploadError> {
        self.transport.write_all(&[CHIP_ERASE, EOC])?;
        let deadline = Instant::now() + ERASE_TIMEOUT;
        while Instant::now() < deadline {
            if self.try_sync()? {
                return Ok(());
            }
            // A board that's mid-erase just doesn't answer, so `try_sync`
            // normally costs a full read timeout and this loop paces itself.
            // A board that *vanishes* mid-erase — USB dropping out during a
            // chip erase is exactly when that happens — fails the read
            // instantly instead, which without this sleep spins a core flat
            // out for the rest of ERASE_TIMEOUT.
            std::thread::sleep(ERASE_POLL_INTERVAL);
        }
        Err(UploadError::Timeout)
    }

    fn program_multi(&mut self, chunk: &[u8]) -> Result<(), UploadError> {
        let mut frame = Vec::with_capacity(chunk.len() + 3);
        frame.push(PROG_MULTI);
        frame.push(chunk.len() as u8);
        frame.extend_from_slice(chunk);
        frame.push(EOC);
        self.transport.write_all(&frame)?;
        self.get_sync()
    }

    fn program(&mut self, image: &[u8], mut on_progress: impl FnMut(usize, usize)) -> Result<(), UploadError> {
        let chunks: Vec<&[u8]> = image.chunks(PROG_MULTI_MAX).collect();
        let total = chunks.len().max(1);
        for (done, chunk) in chunks.iter().enumerate() {
            self.program_multi(chunk)?;
            on_progress(done + 1, total);
        }
        Ok(())
    }

    fn get_crc(&mut self) -> Result<u32, UploadError> {
        self.transport.write_all(&[GET_CRC, EOC])?;
        let value = self.recv_u32()?;
        self.get_sync()?;
        Ok(value)
    }

    fn verify(&mut self, fw: &ApjFirmware, flash_size: u32) -> Result<(), UploadError> {
        let expected = fw.crc(flash_size);
        let reported = self.get_crc()?;
        if reported != expected {
            return Err(UploadError::CrcMismatch { expected, reported });
        }
        Ok(())
    }

    fn reboot(&mut self, bootloader_rev: u32) -> Result<(), UploadError> {
        self.transport.write_all(&[REBOOT, EOC])?;
        // rev3+ can report a failure if the first word of flash didn't
        // take; older bootloaders don't reply to REBOOT at all.
        if bootloader_rev >= 3 {
            self.get_sync()?;
        }
        Ok(())
    }
}

/// Flashes `fw` to whatever's on the other end of `transport`, already
/// sitting in bootloader mode. Mirrors `uploader.py`'s `upload()`: identify
/// → check board_id and size → erase → program → verify CRC → reboot.
///
/// `on_progress` is called at the start and end of each stage (`Program`
/// additionally fires per-chunk) — wire it to a Tauri event to drive a
/// progress bar.
pub fn upload<T: Transport>(
    transport: &mut T,
    fw: &ApjFirmware,
    force_board_mismatch: bool,
    mut on_progress: impl FnMut(UploadStage, usize, usize),
) -> Result<(), UploadError> {
    if fw.has_external_flash_image {
        return Err(UploadError::ExternalFlashUnsupported);
    }

    let mut uploader = Uploader::new(transport);

    on_progress(UploadStage::Identify, 0, 1);
    let info = uploader.identify()?;
    on_progress(UploadStage::Identify, 1, 1);

    if info.board_id != fw.board_id && !force_board_mismatch {
        return Err(UploadError::BoardMismatch { board_expects: info.board_id, firmware_targets: fw.board_id });
    }
    // Checked against the padded image as well as the header's own figure:
    // `image_size` is what the file claims, `image.len()` is what
    // `program()` will actually push through PROG_MULTI, and it's the
    // latter that would run off the end of flash.
    let programmed_size = fw.image.len() as u64;
    if fw.image_size.max(programmed_size) > info.flash_size as u64 {
        return Err(UploadError::ImageTooLarge {
            image_size: fw.image_size.max(programmed_size),
            flash_size: info.flash_size,
        });
    }

    on_progress(UploadStage::Erase, 0, 1);
    uploader.erase()?;
    on_progress(UploadStage::Erase, 1, 1);

    uploader.program(&fw.image, |done, total| on_progress(UploadStage::Program, done, total))?;

    on_progress(UploadStage::Verify, 0, 1);
    uploader.verify(fw, info.flash_size)?;
    on_progress(UploadStage::Verify, 1, 1);

    on_progress(UploadStage::Reboot, 0, 1);
    uploader.reboot(info.bootloader_rev)?;
    on_progress(UploadStage::Reboot, 1, 1);

    Ok(())
}

const BOOTLOADER_POLL_INTERVAL: Duration = Duration::from_millis(50);

/// Polls `transport` for a bootloader until one answers or `deadline`
/// passes. Doesn't try to coax a running vehicle into rebooting itself —
/// callers that have an active MAVLink connection should send a "reboot to
/// bootloader" command first (see `vehicle_command::VehicleCommand::RebootToBootloader`)
/// and disconnect that link before calling this; a freshly plugged-in board
/// also sits in its bootloader for a few seconds on its own, which this
/// will simply catch on an early poll.
pub fn wait_for_bootloader<T: Transport>(transport: &mut T, deadline: Instant) -> Result<BoardInfo, UploadError> {
    loop {
        if let Ok(info) = Uploader::new(transport).identify() {
            return Ok(info);
        }
        if Instant::now() >= deadline {
            return Err(UploadError::Timeout);
        }
        std::thread::sleep(BOOTLOADER_POLL_INTERVAL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    // -------------------------------------------------------------
    // crc32 — cross-checked against vectors computed by running
    // ArduPilot's own `crctab`/`crc32()` from `uploader.py` under
    // Python, not just re-derived from this same Rust code.
    // -------------------------------------------------------------

    #[test]
    fn crc32_matches_reference_vectors() {
        assert_eq!(crc32(b"", 0), 0x00000000);
        assert_eq!(crc32(b"hello", 0), 0xf032519b);
        assert_eq!(crc32(b"AAAAAAAAAA", 0), 0xa404b8b9);
        let seq: Vec<u8> = (0..=255u8).collect();
        assert_eq!(crc32(&seq, 0), 0x2493092b);
    }

    #[test]
    fn apj_crc_pads_with_0xff_up_to_padlen() {
        // 250 bytes 1..=250, padded by `ApjFirmware::parse` to 252.
        let image: Vec<u8> = (1u8..=250).collect();
        let mut padded = image.clone();
        while padded.len() % 4 != 0 {
            padded.push(0xFF);
        }
        let fw = ApjFirmware {
            image: padded,
            image_size: 250,
            board_id: 9,
            board_revision: 0,
            has_external_flash_image: false,
        };
        assert_eq!(fw.crc(1024), 0x5d74ae94);
        assert_eq!(fw.crc(252), 0x561c4eee);
    }

    // Sample .apj generated with ArduPilot's own json/base64/zlib recipe:
    // json.dumps({"image": base64(zlib.compress(bytes(range(1,251)))), ...})
    const SAMPLE_APJ: &str = r#"{"image": "eJwB+gAF/wECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0+P0BBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWltcXV5fYGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9fn+AgYKDhIWGh4iJiouMjY6PkJGSk5SVlpeYmZqbnJ2en6ChoqOkpaanqKmqq6ytrq+wsbKztLW2t7i5uru8vb6/wMHCw8TFxsfIycrLzM3Oz9DR0tPU1dbX2Nna29zd3t/g4eLj5OXm5+jp6uvs7e7v8PHy8/T19vf4+fo6PnqQ", "image_size": 250, "board_id": 9, "board_revision": 0, "git_identity": "deadbeef", "build_time": 1234567890}"#;

    #[test]
    fn apj_parse_decodes_image_and_pads_to_4_bytes() {
        let fw = ApjFirmware::parse(SAMPLE_APJ.as_bytes()).expect("valid sample .apj");
        assert_eq!(fw.board_id, 9);
        assert_eq!(fw.image_size, 250);
        assert_eq!(fw.image.len(), 252); // 250 padded up to a multiple of 4
        let expected: Vec<u8> = (1u8..=250).collect();
        assert_eq!(&fw.image[..250], &expected[..]);
        assert_eq!(&fw.image[250..], &[0xFF, 0xFF]);
        assert!(!fw.has_external_flash_image);
    }

    #[test]
    fn apj_parse_rejects_garbage() {
        assert!(ApjFirmware::parse(b"not json").is_err());
        assert!(ApjFirmware::parse(br#"{"image": "not base64!!", "image_size": 1, "board_id": 1}"#).is_err());
    }

    /// Every real ArduPilot `.apj` carries an `extf_image` key holding an
    /// empty zlib stream. Keying "targets external flash" off the key's
    /// presence rejects every board ArduPilot ships — it has to be measured.
    #[test]
    fn an_empty_extf_image_placeholder_is_not_an_external_flash_build() {
        // The exact placeholder a real .apj carries: zlib of zero bytes.
        let with_placeholder = SAMPLE_APJ
            .replace(r#""board_revision": 0"#, r#""board_revision": 0, "extf_image": "eJwDAAAAAAE=", "extf_image_size": 0"#);
        assert!(with_placeholder.contains("extf_image"), "the fixture should now carry the key");

        let fw = ApjFirmware::parse(with_placeholder.as_bytes()).expect("an empty placeholder should parse");
        assert!(!fw.has_external_flash_image, "an empty extf_image is not an external-flash build");
    }

    /// The flip side: a build that really does carry external flash content
    /// must still be refused, since programming it isn't implemented and a
    /// partial flash is worse than none.
    #[test]
    fn a_populated_extf_image_is_still_refused() {
        let with_content = SAMPLE_APJ
            .replace(r#""board_revision": 0"#, r#""board_revision": 0, "extf_image": "eJxjYGRiZmFlYwcAAFwAHQ==""#);

        let fw = ApjFirmware::parse(with_content.as_bytes()).expect("should parse");
        assert!(fw.has_external_flash_image, "8 bytes of external flash content is an external-flash build");

        let mut mock = MockTransport::new(9, 1024);
        let err = upload(&mut mock, &fw, false, |_, _, _| {}).unwrap_err();
        assert!(matches!(err, UploadError::ExternalFlashUnsupported), "got {err:?}");
    }

    /// Every size check downstream — including the "does it fit in flash"
    /// guard in `upload` — reads the header's `image_size`, so a file whose
    /// header and payload disagree must not get as far as a chip erase.
    #[test]
    fn apj_parse_rejects_a_header_that_disagrees_with_its_payload() {
        let tampered = SAMPLE_APJ.replace(r#""image_size": 250"#, r#""image_size": 4096"#);
        assert_ne!(tampered, SAMPLE_APJ, "the replacement should have matched something");

        // Matched rather than `unwrap_err`'d: `ApjFirmware` deliberately has
        // no `Debug` (it would dump the whole multi-MB image).
        match ApjFirmware::parse(tampered.as_bytes()) {
            Err(UploadError::Apj(msg)) => {
                assert!(msg.contains("image_size=4096"), "{msg}");
                assert!(msg.contains("250 bytes"), "{msg}");
            }
            Err(other) => panic!("expected an Apj error, got {other:?}"),
            Ok(_) => panic!("a header/payload size mismatch should not parse"),
        }
    }

    // -------------------------------------------------------------
    // MockTransport — a fake bootloader implementing the same wire
    // protocol, for testing the `upload()` orchestration end-to-end
    // with no hardware. Not `#[cfg(test)]`-gated below the struct
    // itself since it's only referenced from this test module.
    // -------------------------------------------------------------

    struct MockTransport {
        board_id: u32,
        board_rev: u32,
        bootloader_rev: u32,
        flash: Vec<u8>, // starts all 0xFF (erased) once `erase` runs
        flash_size: u32,
        write_cursor: usize,
        response: VecDeque<u8>,
        erase_polls_remaining: u32,
        deny_sync: bool,
        /// Simulates "board isn't in bootloader mode yet" — every `GET_SYNC`
        /// is silently ignored until this reaches 0, then behaves normally.
        /// Unlike `deny_sync` (permanently unresponsive), this eventually
        /// answers, exercising `wait_for_bootloader`'s retry loop.
        not_ready_polls_remaining: u32,
        corrupt_next_program: bool,
        /// Answers CHIP_ERASE with INSYNC+BAD_SILICON_REV, the way a
        /// bootloader on unprogrammable silicon does.
        bad_silicon: bool,
        baud: u32,
    }

    impl MockTransport {
        fn new(board_id: u32, flash_size: u32) -> Self {
            Self {
                board_id,
                board_rev: 0,
                bootloader_rev: 5,
                flash: vec![0x00; flash_size as usize], // pre-erase garbage; erase() sets 0xFF
                flash_size,
                write_cursor: 0,
                response: VecDeque::new(),
                erase_polls_remaining: 0,
                deny_sync: false,
                not_ready_polls_remaining: 0,
                corrupt_next_program: false,
                bad_silicon: false,
                baud: 115_200,
            }
        }

        fn push_u32(&mut self, v: u32) {
            self.response.extend(v.to_le_bytes());
        }

        fn push_ok(&mut self) {
            self.response.push_back(INSYNC);
            self.response.push_back(OK);
        }

        /// Parses one complete command frame (this crate's `upload()` always
        /// writes a whole frame in one `write_all` call) and queues the
        /// bootloader's reply.
        fn handle_frame(&mut self, frame: &[u8]) {
            if self.deny_sync {
                return; // no reply at all — simulates an unresponsive board
            }
            match frame[0] {
                GET_SYNC => {
                    if self.not_ready_polls_remaining > 0 {
                        self.not_ready_polls_remaining -= 1;
                    } else {
                        self.push_ok();
                    }
                }
                GET_DEVICE => {
                    let value = match frame[1] {
                        INFO_BL_REV => self.bootloader_rev,
                        INFO_BOARD_ID => self.board_id,
                        INFO_BOARD_REV => self.board_rev,
                        INFO_FLASH_SIZE => self.flash_size,
                        _ => 0,
                    };
                    self.push_u32(value);
                    self.push_ok();
                }
                CHIP_ERASE => {
                    if self.bad_silicon {
                        self.response.push_back(INSYNC);
                        self.response.push_back(BAD_SILICON_REV);
                        return;
                    }
                    self.flash.iter_mut().for_each(|b| *b = 0xFF);
                    self.write_cursor = 0;
                    if self.erase_polls_remaining == 0 {
                        self.push_ok();
                    }
                    // else: reply is withheld; `read_exact` below counts down
                    // `erase_polls_remaining` and queues it once ready,
                    // exercising `erase()`'s retry loop.
                }
                PROG_MULTI => {
                    let len = frame[1] as usize;
                    let mut data = frame[2..2 + len].to_vec();
                    if self.corrupt_next_program {
                        data[0] ^= 0xFF;
                        self.corrupt_next_program = false;
                    }
                    let end = (self.write_cursor + len).min(self.flash.len());
                    self.flash[self.write_cursor..end].copy_from_slice(&data[..end - self.write_cursor]);
                    self.write_cursor = end;
                    self.push_ok();
                }
                GET_CRC => {
                    let crc = crc32(&self.flash, 0);
                    self.push_u32(crc);
                    self.push_ok();
                }
                REBOOT => {
                    if self.bootloader_rev >= 3 {
                        self.push_ok();
                    }
                }
                _ => {}
            }
        }
    }

    impl Transport for MockTransport {
        fn write_all(&mut self, data: &[u8]) -> io::Result<()> {
            self.handle_frame(data);
            Ok(())
        }

        fn read_exact(&mut self, buf: &mut [u8]) -> io::Result<()> {
            if self.response.is_empty() && self.erase_polls_remaining > 0 {
                self.erase_polls_remaining -= 1;
                if self.erase_polls_remaining == 0 {
                    self.push_ok();
                }
            }
            if self.response.len() < buf.len() {
                return Err(io::Error::new(io::ErrorKind::TimedOut, "mock: no data ready"));
            }
            for slot in buf.iter_mut() {
                *slot = self.response.pop_front().unwrap();
            }
            Ok(())
        }

        fn discard_input(&mut self) -> io::Result<()> {
            self.response.clear();
            Ok(())
        }
    }

    fn sample_firmware(board_id: u32) -> ApjFirmware {
        ApjFirmware::parse(SAMPLE_APJ.as_bytes()).unwrap().with_board_id_for_test(board_id)
    }

    // Small test-only helper so board-mismatch scenarios don't need a
    // second hand-encoded sample .apj.
    impl ApjFirmware {
        fn with_board_id_for_test(mut self, board_id: u32) -> Self {
            self.board_id = board_id;
            self
        }
    }

    #[test]
    fn upload_succeeds_against_well_behaved_mock_bootloader() {
        let mut mock = MockTransport::new(9, 1024);
        let fw = sample_firmware(9);

        let mut stages = Vec::new();
        let result = upload(&mut mock, &fw, false, |stage, done, total| stages.push((stage, done, total)));

        assert!(result.is_ok(), "{:?}", result.err());
        // The image actually landed in the mock's simulated flash.
        assert_eq!(&mock.flash[..250], &fw.image[..250]);
        // And every stage fired in order.
        assert_eq!(stages.first().unwrap().0, UploadStage::Identify);
        assert_eq!(stages.last().unwrap().0, UploadStage::Reboot);
    }

    #[test]
    fn upload_polls_through_a_slow_erase() {
        let mut mock = MockTransport::new(9, 1024);
        mock.erase_polls_remaining = 3; // bootloader takes a few polls to report ready
        let fw = sample_firmware(9);

        assert!(upload(&mut mock, &fw, false, |_, _, _| {}).is_ok());
    }

    #[test]
    fn upload_rejects_board_id_mismatch_unless_forced() {
        let mut mock = MockTransport::new(50, 1024); // board reports a different board_id
        let fw = sample_firmware(9);

        let err = upload(&mut mock, &fw, false, |_, _, _| {}).unwrap_err();
        assert!(matches!(err, UploadError::BoardMismatch { board_expects: 50, firmware_targets: 9 }));

        // A fresh mock, since the failed attempt above already consumed
        // this one's sync state.
        let mut mock = MockTransport::new(50, 1024);
        assert!(upload(&mut mock, &fw, true, |_, _, _| {}).is_ok(), "force=true should proceed anyway");
    }

    #[test]
    fn upload_rejects_oversized_image() {
        let mut mock = MockTransport::new(9, 64); // flash smaller than the 250-byte image
        let fw = sample_firmware(9);

        let err = upload(&mut mock, &fw, false, |_, _, _| {}).unwrap_err();
        // 252, not the header's 250: the guard reports the padded length
        // that `program()` would actually write.
        assert!(matches!(err, UploadError::ImageTooLarge { image_size: 252, flash_size: 64 }), "got {err:?}");
    }

    /// The header could pass the fit check while the padded image that
    /// actually goes down the wire doesn't — `image_size` is a claim, the
    /// image is what gets programmed.
    #[test]
    fn upload_rejects_an_image_that_only_the_header_claims_fits() {
        let mut mock = MockTransport::new(9, 251);
        let mut fw = sample_firmware(9);
        fw.image_size = 251; // fits 251 bytes of flash; the padded image (252) does not

        let err = upload(&mut mock, &fw, false, |_, _, _| {}).unwrap_err();
        assert!(matches!(err, UploadError::ImageTooLarge { image_size: 252, flash_size: 251 }), "got {err:?}");
    }

    #[test]
    fn upload_fails_closed_on_corrupted_write_instead_of_reporting_success() {
        let mut mock = MockTransport::new(9, 1024);
        mock.corrupt_next_program = true; // simulate a bad write hitting flash
        let fw = sample_firmware(9);

        let err = upload(&mut mock, &fw, false, |_, _, _| {}).unwrap_err();
        assert!(matches!(err, UploadError::CrcMismatch { .. }), "got {err:?}");
    }

    /// `BAD_SILICON_REV` arrives where the erase handshake's OK belongs.
    /// Swallowed as "not ready yet" it would poll for the full erase
    /// timeout and be reported as a dead board, sending the operator after
    /// cables and drivers instead of the actual, unfixable cause.
    #[test]
    fn bad_silicon_is_reported_as_itself_not_as_an_erase_timeout() {
        let mut mock = MockTransport::new(9, 1024);
        mock.bad_silicon = true;
        let fw = sample_firmware(9);

        let started = Instant::now();
        let err = upload(&mut mock, &fw, false, |_, _, _| {}).unwrap_err();
        assert!(matches!(err, UploadError::BadSiliconRevision), "got {err:?}");
        assert!(started.elapsed() < ERASE_TIMEOUT, "it should fail immediately, not poll to the deadline");
    }

    #[test]
    fn upload_times_out_against_an_unresponsive_board() {
        let mut mock = MockTransport::new(9, 1024);
        mock.deny_sync = true;
        let fw = sample_firmware(9);

        let err = upload(&mut mock, &fw, false, |_, _, _| {}).unwrap_err();
        assert!(matches!(err, UploadError::Timeout));
    }

    #[test]
    fn upload_rejects_unsupported_bootloader_revision() {
        let mut mock = MockTransport::new(9, 1024);
        mock.bootloader_rev = 2; // predates CRC-based verify — not ported
        let fw = sample_firmware(9);

        let err = upload(&mut mock, &fw, false, |_, _, _| {}).unwrap_err();
        assert!(matches!(err, UploadError::UnsupportedBootloaderRevision(2)));
    }

    #[test]
    fn wait_for_bootloader_retries_until_the_board_answers() {
        let mut mock = MockTransport::new(9, 1024);
        mock.not_ready_polls_remaining = 3; // board isn't in bootloader mode for its first 3 polls

        let info = wait_for_bootloader(&mut mock, Instant::now() + Duration::from_secs(5)).expect("should eventually sync");
        assert_eq!(info.board_id, 9);
    }

    #[test]
    fn wait_for_bootloader_gives_up_after_its_deadline() {
        let mut mock = MockTransport::new(9, 1024);
        mock.deny_sync = true; // never answers

        let err = wait_for_bootloader(&mut mock, Instant::now() + Duration::from_millis(200)).unwrap_err();
        assert!(matches!(err, UploadError::Timeout));
    }

    #[test]
    fn upload_rejects_external_flash_images() {
        let mut mock = MockTransport::new(9, 1024);
        let mut fw = sample_firmware(9);
        fw.has_external_flash_image = true;

        let err = upload(&mut mock, &fw, false, |_, _, _| {}).unwrap_err();
        assert!(matches!(err, UploadError::ExternalFlashUnsupported));
    }
}
