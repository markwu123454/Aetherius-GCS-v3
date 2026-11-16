//! Shared between the `aetherius-cli` binary and the Aetherius GCS app:
//! the wire protocol, and the one definition of every command — what it's
//! called, what it takes, which permission category it falls under and what
//! its reply looks like. The CLI parses arguments and prints help from these
//! definitions; the app's control server checks permissions against them.

pub mod catalog;
pub mod parse;
pub mod protocol;
pub mod shape;
