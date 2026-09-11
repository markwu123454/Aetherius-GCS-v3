//! ArduPilot's serial bootloader protocol — a Rust port of the `uploader`
//! and `firmware` classes in ArduPilot's own `Tools/scripts/uploader.py`
//! (https://github.com/ArduPilot/ardupilot/blob/master/Tools/scripts/uploader.py).
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

use std::fmt;
use std::io::{self, Read};
use std::time::{Duration, Instant};

use base64::Engine;
use flate2::read::ZlibDecoder;
use serde::Deserialize;

// Table transcribed verbatim from `uploader.py`'s `crctab`.

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

#[derive(Deserialize)]
struct ApjDesc {
    image: String,
    image_size: u64,
    board_id: u32,
    #[serde(default)]
    board_revision: u32,
    extf_image: Option<String>,
}

#[derive(Clone)]
pub struct ApjFirmware {
    /// Decompressed image, padded to a 4-byte boundary with 0xFF because
    /// `PROG_MULTI` writes whole 32-bit words.
    pub image: Vec<u8>,
    pub image_size: u64,
    pub board_id: u32,
    pub board_revision: u32,
    pub has_external_flash_image: bool,
}

/// Hard ceiling on a decompressed `.apj` image — the largest boards ArduPilot
/// ship have 2 MB of flash, so anything near this is corrupt or a zip bomb, and
/// `read_to_end` on a `ZlibDecoder` would otherwise allocate until the process
/// dies. (Guard not present in `uploader.py`.)
const MAX_IMAGE_BYTES: u64 = 32 * 1024 * 1024;

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

        // Measured, not merely detected: every real ArduPilot `.apj` carries an
        // `extf_image` key that decompresses to zero bytes, so keying off its
        // presence would reject every board there is.
        let external_flash_bytes = match desc.extf_image.as_deref() {
            Some(encoded) => decode_apj_image(encoded, "extf_image")?.len(),
            None => 0,
        };

        // Added check (not in `uploader.py`): every downstream size check trusts
        // the header's `image_size`, so reject a file whose header disagrees with
        // its decompressed payload rather than erasing a board on a bad number.
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

    /// CRC over the image plus 0xFF padding out to `padlen`, which must be the
    /// board's *flash size*: after a chip erase the whole region reads 0xFF and
    /// programming only overwrites the image's bytes, so the board's `GET_CRC`
    /// covers everything up to flash size, not just what was written.
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
    /// Discards buffered input (pyserial's `flushInput()`) before a sync
    /// attempt, so a stale half-conversation from an aborted attempt can't be
    /// mistaken for a real response.
    fn discard_input(&mut self) -> io::Result<()>;
}

pub struct SerialTransport(Box<dyn serialport::SerialPort>);

impl SerialTransport {
    pub fn new(port: Box<dyn serialport::SerialPort>) -> Self {
        Self(port)
    }

    /// Promotes the short scan timeout to the long flash timeout in place,
    /// rather than closing and re-opening the port — a board with intact
    /// firmware only holds in its bootloader for a few seconds, so handing that
    /// window back by re-opening is a real risk.
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

const INSYNC: u8 = 0x12;
const EOC: u8 = 0x20;

const OK: u8 = 0x10;
const FAILED: u8 = 0x11;
const INVALID: u8 = 0x13;
/// rev5+. Reported instead of OK when the silicon revision can't be programmed
/// reliably (the STM32F4 flash erratum). It arrives where an erase handshake's
/// OK belongs, so it's handled explicitly rather than mistaken for a silent
/// board and left to time out.
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

const ERASE_TIMEOUT: Duration = Duration::from_secs(20); // erase is very slow, give it 20s (uploader.py)
const ERASE_POLL_INTERVAL: Duration = Duration::from_millis(50);

#[derive(Debug)]
pub enum UploadError {
    Io(io::Error),
    Timeout,
    UnexpectedResponse { expected: &'static str, got: u8 },
    BootloaderReportedFailure,
    BootloaderReportedInvalidOperation,
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

    /// Like `get_sync`, but a non-answer (wrong byte, timeout, I/O error) means
    /// "not synced yet" rather than a hard failure — for polling the bootloader
    /// until it's ready again (e.g. after an erase). `BAD_SILICON_REV` is the
    /// exception: a definite "this chip cannot be programmed", so it propagates
    /// instead of looping to the deadline, as `uploader.py`'s `__trySync` does.
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

    /// No progress callback, deliberately: the bootloader is silent for the
    /// whole erase (nothing until it answers INSYNC+OK), so there's nothing to
    /// report. `uploader.py` draws a bar against a hardcoded ~9s guess; we show
    /// an indeterminate state instead.
    fn erase(&mut self) -> Result<(), UploadError> {
        self.transport.write_all(&[CHIP_ERASE, EOC])?;
        let deadline = Instant::now() + ERASE_TIMEOUT;
        while Instant::now() < deadline {
            if self.try_sync()? {
                return Ok(());
            }
            // Pace the loop: `try_sync` usually blocks on the read timeout, but
            // a board that vanishes mid-erase (USB dropping out) fails the read
            // instantly and would otherwise spin a core flat out until the
            // deadline.
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

/// Flashes `fw` onto a `transport` already sitting in bootloader mode.
/// `on_progress` fires at the start and end of each stage (`Program` also
/// per-chunk) — wire it to a Tauri event to drive a progress bar.
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
    // Stricter than `uploader.py`: also check the padded `image.len()`, since
    // that's what `program()` actually pushes through PROG_MULTI and what would
    // run off the end of flash — not just the header's `image_size`.
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

/// Polls `transport` until a bootloader answers or `deadline` passes. Doesn't
/// try to reboot a running vehicle itself — callers with an active MAVLink link
/// should trigger `vehicle_command::VehicleCommand::RebootToBootloader` and
/// disconnect first (a freshly plugged-in board sits in its bootloader for a
/// few seconds anyway, which an early poll catches).
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
