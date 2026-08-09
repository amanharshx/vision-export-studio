use std::sync::{Arc, Mutex};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RuntimeOperation {
    Export,
    Install,
    Setup,
    Rebuild,
}

impl RuntimeOperation {
    fn name(self) -> &'static str {
        match self {
            Self::Export => "export",
            Self::Install => "dependency install",
            Self::Setup => "setup",
            Self::Rebuild => "managed runtime rebuild",
        }
    }
}

#[derive(Default)]
struct CoordinatorState {
    active: Option<RuntimeOperation>,
}

#[derive(Default, Clone)]
pub struct RuntimeOperationCoordinator {
    state: Arc<Mutex<CoordinatorState>>,
}

pub struct RuntimeOperationGuard {
    state: Arc<Mutex<CoordinatorState>>,
    operation: RuntimeOperation,
}

impl RuntimeOperationCoordinator {
    pub fn acquire(&self, operation: RuntimeOperation) -> Result<RuntimeOperationGuard, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "runtime operation coordinator lock poisoned".to_string())?;
        if let Some(active) = state.active {
            return Err(format!(
                "another runtime operation is in progress: {}",
                active.name()
            ));
        }
        state.active = Some(operation);
        Ok(RuntimeOperationGuard {
            state: Arc::clone(&self.state),
            operation,
        })
    }
}

impl Drop for RuntimeOperationGuard {
    fn drop(&mut self) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if state.active == Some(self.operation) {
            state.active = None;
        }
    }
}

pub(crate) fn emit_after_operation_released<T>(
    operation_guard: RuntimeOperationGuard,
    emit: impl FnOnce() -> T,
) -> T {
    drop(operation_guard);
    emit()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_operations_block_each_other_with_operation_name() {
        let coordinator = RuntimeOperationCoordinator::default();
        for (active, blocked, name) in [
            (
                RuntimeOperation::Export,
                RuntimeOperation::Install,
                "export",
            ),
            (
                RuntimeOperation::Install,
                RuntimeOperation::Rebuild,
                "dependency install",
            ),
            (
                RuntimeOperation::Rebuild,
                RuntimeOperation::Export,
                "managed runtime rebuild",
            ),
            (RuntimeOperation::Setup, RuntimeOperation::Rebuild, "setup"),
        ] {
            let guard = coordinator.acquire(active).unwrap();
            assert!(coordinator.acquire(blocked).err().unwrap().contains(name));
            drop(guard);
        }
    }

    #[test]
    fn dropping_guard_allows_next_operation() {
        let coordinator = RuntimeOperationCoordinator::default();
        let operation = coordinator.acquire(RuntimeOperation::Setup).unwrap();
        drop(operation);

        assert!(coordinator.acquire(RuntimeOperation::Rebuild).is_ok());
    }

    #[test]
    fn dropping_guard_after_failure_path_unblocks_future_operations() {
        let coordinator = RuntimeOperationCoordinator::default();
        let result: Result<(), ()> = {
            let _operation = coordinator.acquire(RuntimeOperation::Install).unwrap();
            Err(())
        };
        assert!(result.is_err());

        assert!(coordinator.acquire(RuntimeOperation::Rebuild).is_ok());
    }

    #[test]
    fn terminal_event_runs_after_guard_is_released() {
        let coordinator = RuntimeOperationCoordinator::default();
        let guard = coordinator.acquire(RuntimeOperation::Install).unwrap();

        emit_after_operation_released(guard, || {
            assert!(coordinator.acquire(RuntimeOperation::Export).is_ok());
        });
    }
}
