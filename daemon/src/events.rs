//! Event plumbing from daemon subsystems to the stdout RPC writer.

use crate::contracts::DaemonEvent;
use tokio::sync::mpsc;

pub type EventTx = mpsc::UnboundedSender<DaemonEvent>;
pub type EventRx = mpsc::UnboundedReceiver<DaemonEvent>;

pub fn channel() -> (EventTx, EventRx) {
    mpsc::unbounded_channel()
}
